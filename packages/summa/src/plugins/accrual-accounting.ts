// =============================================================================
// ACCRUAL ACCOUNTING PLUGIN -- Revenue/expense recognition over time
// =============================================================================
// Recognize revenue/expense over time via scheduled journal entries.
// Example: 12L annual insurance paid in Jan -> 1L/month expense over 12 months.

import type {
	PluginApiRequest,
	PluginApiResponse,
	SummaContext,
	SummaPlugin,
} from "@summa-ledger/core";
import { SummaError } from "@summa-ledger/core";
import { createTableResolver } from "@summa-ledger/core/db";
import { initializeEntityStatus, transitionEntityStatus } from "../infrastructure/entity-status.js";
import { journalEntry } from "../managers/journal-manager.js";

// =============================================================================
// TYPES
// =============================================================================

export interface AccrualAccountingOptions {
	/** Automatically process accruals via worker. Default: true */
	autoProcess?: boolean;
}

export type AccrualType = "revenue" | "expense" | "prepaid" | "unearned";
export type AccrualFrequency = "monthly" | "quarterly" | "yearly";
export type AccrualStatus = "active" | "completed" | "cancelled";

const ENTITY_TYPE = "accrual_schedule";

export interface AccrualSchedule {
	id: string;
	type: AccrualType;
	sourceAccountId: string;
	targetAccountId: string;
	totalAmount: number;
	recognizedAmount: number;
	remainingAmount: number;
	periods: number;
	startDate: string;
	endDate: string;
	frequency: AccrualFrequency;
	status: AccrualStatus;
	currency: string;
	metadata: Record<string, unknown>;
	createdAt: string;
}

export interface AccrualPosting {
	id: string;
	scheduleId: string;
	periodDate: string;
	amount: number;
	transactionId: string | null;
	postedAt: string | null;
	createdAt: string;
}

interface RawScheduleRow {
	id: string;
	type: string;
	source_account_id: string;
	target_account_id: string;
	total_amount: number;
	recognized_amount: number;
	remaining_amount: number;
	periods: number;
	start_date: string | Date;
	end_date: string | Date;
	frequency: string;
	/** Populated via LATERAL JOIN to entity_status_log */
	status: string;
	currency: string;
	metadata: Record<string, unknown>;
	created_at: string | Date;
}

interface RawPostingRow {
	id: string;
	schedule_id: string;
	period_date: string | Date;
	amount: number;
	transaction_id: string | null;
	posted_at: string | Date | null;
	created_at: string | Date;
}

// =============================================================================
// HELPERS
// =============================================================================

function rawToSchedule(row: RawScheduleRow): AccrualSchedule {
	return {
		id: row.id,
		type: row.type as AccrualType,
		sourceAccountId: row.source_account_id,
		targetAccountId: row.target_account_id,
		totalAmount: Number(row.total_amount),
		recognizedAmount: Number(row.recognized_amount),
		remainingAmount: Number(row.remaining_amount),
		periods: Number(row.periods),
		startDate:
			row.start_date instanceof Date ? row.start_date.toISOString() : String(row.start_date),
		endDate: row.end_date instanceof Date ? row.end_date.toISOString() : String(row.end_date),
		frequency: row.frequency as AccrualFrequency,
		status: row.status as AccrualStatus,
		currency: row.currency,
		metadata: row.metadata ?? {},
		createdAt:
			row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
	};
}

function rawToPosting(row: RawPostingRow): AccrualPosting {
	return {
		id: row.id,
		scheduleId: row.schedule_id,
		periodDate:
			row.period_date instanceof Date ? row.period_date.toISOString() : String(row.period_date),
		amount: Number(row.amount),
		transactionId: row.transaction_id,
		postedAt: row.posted_at
			? row.posted_at instanceof Date
				? row.posted_at.toISOString()
				: String(row.posted_at)
			: null,
		createdAt:
			row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
	};
}

function jsonRes(status: number, body: unknown): PluginApiResponse {
	return { status, body };
}

/** Calculate per-period amount with remainder added to last period */
function computePerPeriodAmounts(totalAmount: number, periods: number): number[] {
	const perPeriod = Math.floor(totalAmount / periods);
	const remainder = totalAmount - perPeriod * periods;
	const amounts: number[] = [];
	for (let i = 0; i < periods; i++) {
		amounts.push(i === periods - 1 ? perPeriod + remainder : perPeriod);
	}
	return amounts;
}

/** Generate period dates based on frequency */
function generatePeriodDates(
	startDate: Date,
	periods: number,
	frequency: AccrualFrequency,
): Date[] {
	const dates: Date[] = [];
	for (let i = 0; i < periods; i++) {
		const d = new Date(startDate);
		switch (frequency) {
			case "monthly":
				d.setMonth(d.getMonth() + i);
				break;
			case "quarterly":
				d.setMonth(d.getMonth() + i * 3);
				break;
			case "yearly":
				d.setFullYear(d.getFullYear() + i);
				break;
		}
		dates.push(d);
	}
	return dates;
}

/** Build a LATERAL JOIN subquery that fetches the current status from entity_status_log */
function statusLateral(t: (name: string) => string, tableAlias: string): string {
	return `JOIN LATERAL (
  SELECT status FROM ${t("entity_status_log")}
  WHERE entity_type = '${ENTITY_TYPE}' AND entity_id = ${tableAlias}.id
  ORDER BY created_at DESC
  LIMIT 1
) esl ON true`;
}

// =============================================================================
// CORE OPERATIONS
// =============================================================================

export async function createAccrualSchedule(
	ctx: SummaContext,
	params: {
		type: AccrualType;
		sourceAccountId: string;
		targetAccountId: string;
		totalAmount: number;
		periods: number;
		startDate: string;
		frequency: AccrualFrequency;
		currency: string;
		metadata?: Record<string, unknown>;
	},
): Promise<AccrualSchedule> {
	if (params.totalAmount <= 0) {
		throw SummaError.invalidArgument("totalAmount must be positive");
	}
	if (params.periods <= 0) {
		throw SummaError.invalidArgument("periods must be positive");
	}

	const startDate = new Date(params.startDate);
	const periodDates = generatePeriodDates(startDate, params.periods, params.frequency);
	const endDate = periodDates[periodDates.length - 1];
	if (!endDate) throw SummaError.internal("Failed to compute end date");

	const perPeriodAmounts = computePerPeriodAmounts(params.totalAmount, params.periods);

	const t = createTableResolver(ctx.options.schema);

	// Insert schedule (no status column — status lives in entity_status_log)
	const scheduleRows = await ctx.adapter.raw<Omit<RawScheduleRow, "status">>(
		`INSERT INTO ${t("accrual_schedule")}
     (type, source_account_id, target_account_id, total_amount, recognized_amount,
      remaining_amount, periods, start_date, end_date, frequency, currency, metadata)
     VALUES ($1, $2, $3, $4, 0, $4, $5, $6::timestamptz, $7::timestamptz, $8, $9, $10::jsonb)
     RETURNING *`,
		[
			params.type,
			params.sourceAccountId,
			params.targetAccountId,
			params.totalAmount,
			params.periods,
			startDate.toISOString(),
			endDate.toISOString(),
			params.frequency,
			params.currency,
			JSON.stringify(params.metadata ?? {}),
		],
	);
	const schedule = scheduleRows[0];
	if (!schedule) throw SummaError.internal("Failed to create accrual schedule");

	// Initialize status to 'active' in entity_status_log
	await initializeEntityStatus(ctx.adapter, ENTITY_TYPE, schedule.id, "active", {
		recognized_amount: 0,
		remaining_amount: params.totalAmount,
	});

	// Insert posting records (one per period)
	for (let i = 0; i < periodDates.length; i++) {
		const periodDate = periodDates[i];
		if (!periodDate) continue;
		await ctx.adapter.raw(
			`INSERT INTO ${t("accrual_posting")} (schedule_id, period_date, amount)
       VALUES ($1, $2::timestamptz, $3)`,
			[schedule.id, periodDate.toISOString(), perPeriodAmounts[i]],
		);
	}

	return rawToSchedule({ ...schedule, status: "active" });
}

export async function listSchedules(
	ctx: SummaContext,
	status?: AccrualStatus,
): Promise<AccrualSchedule[]> {
	const t = createTableResolver(ctx.options.schema);
	const lateral = statusLateral(t, "s");
	const filter = status ? `WHERE esl.status = $1` : "";
	const params = status ? [status] : [];
	const rows = await ctx.adapter.raw<RawScheduleRow>(
		`SELECT s.*, esl.status FROM ${t("accrual_schedule")} s
     ${lateral}
     ${filter}
     ORDER BY s.created_at DESC`,
		params,
	);
	return rows.map(rawToSchedule);
}

export async function getSchedule(
	ctx: SummaContext,
	scheduleId: string,
): Promise<{
	schedule: AccrualSchedule;
	postings: AccrualPosting[];
}> {
	const t = createTableResolver(ctx.options.schema);
	const lateral = statusLateral(t, "s");
	const scheduleRows = await ctx.adapter.raw<RawScheduleRow>(
		`SELECT s.*, esl.status FROM ${t("accrual_schedule")} s
     ${lateral}
     WHERE s.id = $1`,
		[scheduleId],
	);
	const row = scheduleRows[0];
	if (!row) throw SummaError.notFound("Accrual schedule not found");

	const postingRows = await ctx.adapter.raw<RawPostingRow>(
		`SELECT * FROM ${t("accrual_posting")} WHERE schedule_id = $1 ORDER BY period_date`,
		[scheduleId],
	);

	return {
		schedule: rawToSchedule(row),
		postings: postingRows.map(rawToPosting),
	};
}

export async function cancelSchedule(
	ctx: SummaContext,
	scheduleId: string,
): Promise<AccrualSchedule> {
	const t = createTableResolver(ctx.options.schema);

	// Transition status from 'active' to 'cancelled' in entity_status_log
	await transitionEntityStatus({
		tx: ctx.adapter,
		entityType: ENTITY_TYPE,
		entityId: scheduleId,
		status: "cancelled",
		expectedCurrentStatus: "active",
		reason: "Schedule cancelled by user",
	});

	// Re-read the schedule to return it
	const lateral = statusLateral(t, "s");
	const rows = await ctx.adapter.raw<RawScheduleRow>(
		`SELECT s.*, esl.status FROM ${t("accrual_schedule")} s
     ${lateral}
     WHERE s.id = $1`,
		[scheduleId],
	);
	const row = rows[0];
	if (!row) throw SummaError.notFound("Accrual schedule not found");
	return rawToSchedule(row);
}

export async function processAccruals(
	ctx: SummaContext,
	params: { periodDate?: Date },
): Promise<{ processed: number; skipped: number }> {
	const asOf = params.periodDate ?? new Date();
	let processed = 0;
	let skipped = 0;

	const t = createTableResolver(ctx.options.schema);

	// Find unposted accrual postings whose period_date has passed.
	// Use LATERAL JOIN to entity_status_log for the schedule's current status.
	const pendingPostings = await ctx.adapter.raw<
		RawPostingRow & {
			schedule_status: string;
			source_account_id: string;
			target_account_id: string;
			schedule_currency: string;
			schedule_recognized_amount: number;
			schedule_remaining_amount: number;
		}
	>(
		`SELECT ap.*, esl.status as schedule_status,
		        s.source_account_id, s.target_account_id, s.currency as schedule_currency,
		        s.recognized_amount as schedule_recognized_amount,
		        s.remaining_amount as schedule_remaining_amount
     FROM ${t("accrual_posting")} ap
     JOIN ${t("accrual_schedule")} s ON s.id = ap.schedule_id
     JOIN LATERAL (
       SELECT status FROM ${t("entity_status_log")}
       WHERE entity_type = '${ENTITY_TYPE}' AND entity_id = s.id
       ORDER BY created_at DESC
       LIMIT 1
     ) esl ON true
     WHERE ap.posted_at IS NULL
       AND ap.period_date <= $1::timestamptz
       AND esl.status = 'active'
     ORDER BY ap.period_date`,
		[asOf.toISOString()],
	);

	for (const posting of pendingPostings) {
		try {
			// Resolve account UUIDs to holder_ids for journalEntry
			const sourceRows = await ctx.adapter.raw<{ holder_id: string }>(
				`SELECT holder_id FROM ${t("account")} WHERE id = $1`,
				[posting.source_account_id],
			);
			const targetRows = await ctx.adapter.raw<{ holder_id: string }>(
				`SELECT holder_id FROM ${t("account")} WHERE id = $1`,
				[posting.target_account_id],
			);
			const sourceHolderId = sourceRows[0]?.holder_id;
			const targetHolderId = targetRows[0]?.holder_id;
			if (!sourceHolderId || !targetHolderId) {
				ctx.logger.error("Accrual posting skipped: account not found", {
					postingId: posting.id,
					sourceAccountId: posting.source_account_id,
					targetAccountId: posting.target_account_id,
				});
				skipped++;
				continue;
			}

			const periodStr =
				posting.period_date instanceof Date
					? posting.period_date.toISOString()
					: String(posting.period_date);

			// Create actual journal entry for this accrual posting
			const txn = await journalEntry(ctx, {
				entries: [
					{ holderId: sourceHolderId, direction: "debit", amount: Number(posting.amount) },
					{ holderId: targetHolderId, direction: "credit", amount: Number(posting.amount) },
				],
				reference: `accrual:${posting.schedule_id}:${posting.id}`,
				description: `Accrual posting for period ${periodStr}`,
				metadata: {
					accrualScheduleId: posting.schedule_id,
					accrualPostingId: posting.id,
				},
			});

			// Mark posting as posted with transaction_id
			await ctx.adapter.raw(
				`UPDATE ${t("accrual_posting")} SET posted_at = NOW(), transaction_id = $2 WHERE id = $1`,
				[posting.id, txn.id],
			);

			// Update schedule recognized/remaining amounts (mutable numeric fields stay on the table)
			const newRecognized = Number(posting.schedule_recognized_amount) + Number(posting.amount);
			const newRemaining = Number(posting.schedule_remaining_amount) - Number(posting.amount);

			await ctx.adapter.raw(
				`UPDATE ${t("accrual_schedule")}
         SET recognized_amount = recognized_amount + $1,
             remaining_amount = remaining_amount - $1
         WHERE id = $2`,
				[posting.amount, posting.schedule_id],
			);

			// If fully recognized, transition status to 'completed'
			if (newRemaining <= 0) {
				await transitionEntityStatus({
					tx: ctx.adapter,
					entityType: ENTITY_TYPE,
					entityId: posting.schedule_id,
					status: "completed",
					expectedCurrentStatus: "active",
					reason: "All periods recognized",
					metadata: {
						recognized_amount: newRecognized,
						remaining_amount: 0,
					},
				});
			}

			processed++;
		} catch (err) {
			ctx.logger.error("Accrual posting failed", {
				postingId: posting.id,
				scheduleId: posting.schedule_id,
				error: err instanceof Error ? err.message : "Unknown error",
			});
			skipped++;
		}
	}

	return { processed, skipped };
}

// =============================================================================
// PLUGIN FACTORY
// =============================================================================

export function accrualAccounting(options?: AccrualAccountingOptions): SummaPlugin {
	const autoProcess = options?.autoProcess ?? true;

	return {
		id: "accrual-accounting",

		schema: {
			accrual_schedule: {
				columns: {
					id: { type: "uuid", primaryKey: true },
					type: { type: "text", notNull: true },
					source_account_id: {
						type: "uuid",
						notNull: true,
						references: { table: "account", column: "id" },
					},
					target_account_id: {
						type: "uuid",
						notNull: true,
						references: { table: "account", column: "id" },
					},
					total_amount: { type: "bigint", notNull: true },
					recognized_amount: { type: "bigint", default: "0" },
					remaining_amount: { type: "bigint", notNull: true },
					periods: { type: "integer", notNull: true },
					start_date: { type: "timestamp", notNull: true },
					end_date: { type: "timestamp", notNull: true },
					frequency: { type: "text", notNull: true },
					currency: { type: "text", notNull: true },
					metadata: { type: "jsonb", default: "'{}'" },
					created_at: { type: "timestamp", default: "NOW()" },
				},
				indexes: [{ name: "idx_accrual_schedule_type", columns: ["type"] }],
			},
			accrual_posting: {
				columns: {
					id: { type: "uuid", primaryKey: true },
					schedule_id: {
						type: "uuid",
						notNull: true,
						references: { table: "accrual_schedule", column: "id" },
					},
					period_date: { type: "timestamp", notNull: true },
					amount: { type: "bigint", notNull: true },
					transaction_id: { type: "uuid" },
					posted_at: { type: "timestamp" },
					created_at: { type: "timestamp", default: "NOW()" },
				},
				indexes: [
					{
						name: "uq_accrual_posting_schedule_period",
						columns: ["schedule_id", "period_date"],
						unique: true,
					},
					{ name: "idx_accrual_posting_schedule", columns: ["schedule_id"] },
				],
			},
		},

		workers: autoProcess
			? [
					{
						id: "accrual-processor",
						description: "Process due accrual postings",
						interval: "1d",
						leaseRequired: true,
						handler: async (ctx) => {
							const result = await processAccruals(ctx, { periodDate: new Date() });
							if (result.processed > 0 || result.skipped > 0) {
								ctx.logger.info("Accrual processing complete", result);
							}
						},
					},
				]
			: [],

		endpoints: [
			{
				method: "GET",
				path: "/accruals",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const schedules = await listSchedules(ctx, req.query.status as AccrualStatus | undefined);
					return jsonRes(200, schedules);
				},
			},
			{
				method: "POST",
				path: "/accruals",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const body = req.body as {
						type: AccrualType;
						sourceAccountId: string;
						targetAccountId: string;
						totalAmount: number;
						periods: number;
						startDate: string;
						frequency: AccrualFrequency;
						currency: string;
						metadata?: Record<string, unknown>;
					};
					if (
						!body.type ||
						!body.sourceAccountId ||
						!body.targetAccountId ||
						!body.totalAmount ||
						!body.periods ||
						!body.startDate ||
						!body.frequency ||
						!body.currency
					) {
						return jsonRes(400, {
							error: {
								code: "VALIDATION_ERROR",
								message:
									"type, sourceAccountId, targetAccountId, totalAmount, periods, startDate, frequency, currency required",
							},
						});
					}
					const schedule = await createAccrualSchedule(ctx, body);
					return jsonRes(201, schedule);
				},
			},
			{
				method: "GET",
				path: "/accruals/:id",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const result = await getSchedule(ctx, req.params.id ?? "");
					return jsonRes(200, result);
				},
			},
			{
				method: "DELETE",
				path: "/accruals/:id",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const schedule = await cancelSchedule(ctx, req.params.id ?? "");
					return jsonRes(200, schedule);
				},
			},
		],
	};
}
