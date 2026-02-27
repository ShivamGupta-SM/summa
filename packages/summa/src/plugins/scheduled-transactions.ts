// =============================================================================
// SCHEDULED TRANSACTIONS PLUGIN -- Schedule future & recurring transactions
// =============================================================================
// Provides a typed creation API for scheduling one-time and recurring
// transactions, plus a background worker that polls for due transactions and
// executes them via the transaction manager (credit/debit/transfer).
//
// Status is tracked via entity_status_log (append-only) instead of a mutable
// status column on the scheduled_transaction table.  Mutable execution
// counters (execution_count, retry_count, last_executed_at, next_execution_at,
// last_retry_at) are stored as metadata on the entity_status_log rows.

import type {
	PluginApiRequest,
	PluginApiResponse,
	SummaContext,
	SummaPlugin,
	TableDefinition,
} from "@summa-ledger/core";
import { SummaError } from "@summa-ledger/core";
import { createTableResolver } from "@summa-ledger/core/db";
import {
	getEntityStatus,
	initializeEntityStatus,
	transitionEntityStatus,
} from "../infrastructure/entity-status.js";
import { withTransactionTimeout } from "../infrastructure/event-store.js";
import { getLedgerId } from "../managers/ledger-helpers.js";
import { creditAccount, debitAccount, transfer } from "../managers/transaction-manager.js";

// =============================================================================
// CONSTANTS
// =============================================================================

const ENTITY_TYPE = "scheduled_transaction" as const;

// =============================================================================
// OPTIONS
// =============================================================================

export interface ScheduledTransactionsOptions {
	/** Max retries before marking as failed. Default: 3 */
	maxRetries?: number;
	/** Batch size for candidate fetching. Default: 100 */
	batchSize?: number;
	/** Max batches per run (safety cap). Default: 50 */
	maxBatchesPerRun?: number;
}

// =============================================================================
// PUBLIC TYPES
// =============================================================================

export interface CreateScheduledTransactionParams {
	/** Source holder ID or system account (e.g., "@World") */
	sourceIdentifier: string;
	/** Destination holder ID or system account (e.g., "@Fees"). Required for transfers. */
	destinationIdentifier?: string | null;
	/** Amount in smallest currency unit (e.g., cents) */
	amount: number;
	/** ISO 4217 currency code */
	currency?: string;
	/** When to execute. ISO 8601 string or Date. */
	scheduledFor: Date | string;
	/** Optional unique reference for idempotency */
	reference?: string;
	/** Recurrence configuration for recurring schedules */
	recurrence?: RecurrenceInput;
}

export interface RecurrenceInput {
	/** Interval between executions in milliseconds */
	intervalMs: number;
	/** Maximum number of executions (omit for unlimited) */
	maxExecutions?: number;
}

export type ScheduledTransactionStatus =
	| "scheduled"
	| "processing"
	| "completed"
	| "failed"
	| "cancelled";

export interface ScheduledTransaction {
	id: string;
	reference: string | null;
	amount: number;
	currency: string;
	sourceIdentifier: string;
	destinationIdentifier: string | null;
	scheduledFor: string;
	recurrence: RecurrenceInput | null;
	status: ScheduledTransactionStatus;
	executionCount: number;
	retryCount: number;
	lastExecutedAt: string | null;
	nextExecutionAt: string | null;
	createdAt: string;
}

// =============================================================================
// RAW ROW TYPES
// =============================================================================

interface RawScheduledRow {
	id: string;
}

interface RawScheduledInsertRow {
	id: string;
	reference: string | null;
	amount: number;
	currency: string;
	source_identifier: string;
	destination_identifier: string | null;
	scheduled_for: string | Date;
	recurrence: Recurrence | string | null;
	status: string;
	execution_count: number;
	retry_count: number;
	last_executed_at: string | Date | null;
	next_execution_at: string | Date | null;
	created_at: string | Date;
}

/** Row shape returned by the LATERAL JOIN candidate query. */
interface RawScheduledDetailRow {
	id: string;
	reference: string | null;
	amount: number;
	currency: string;
	source_identifier: string;
	destination_identifier: string | null;
	scheduled_for: string | Date;
	recurrence: Recurrence | string | null;
	// Mutable fields come from entity_status_log metadata
	current_status: string;
	status_metadata: Record<string, unknown> | null;
}

interface Recurrence {
	intervalMs: number;
	maxExecutions?: number;
}

function json(status: number, body: unknown): PluginApiResponse {
	return { status, body };
}

// =============================================================================
// SCHEMA
// =============================================================================

const scheduledTransactionSchema: Record<string, TableDefinition> = {
	scheduled_transaction: {
		columns: {
			id: { type: "uuid", primaryKey: true, notNull: true },
			ledger_id: { type: "uuid", notNull: true },
			reference: { type: "text" },
			amount: { type: "bigint", notNull: true },
			currency: { type: "text", notNull: true },
			source_identifier: { type: "text", notNull: true },
			destination_identifier: { type: "text" },
			scheduled_for: { type: "timestamp", notNull: true },
			recurrence: { type: "jsonb" },
			status: { type: "text", notNull: true, default: "'scheduled'" },
			execution_count: { type: "integer", notNull: true, default: "0" },
			retry_count: { type: "integer", notNull: true, default: "0" },
			last_executed_at: { type: "timestamp" },
			next_execution_at: { type: "timestamp" },
			last_retry_at: { type: "timestamp" },
			created_at: { type: "timestamp", notNull: true, default: "NOW()" },
		},
		indexes: [
			{ name: "idx_scheduled_pending", columns: ["next_execution_at"] },
			{ name: "idx_scheduled_ledger", columns: ["ledger_id"] },
			{ name: "idx_scheduled_source", columns: ["source_identifier"] },
			{ name: "idx_scheduled_status", columns: ["status", "next_execution_at"] },
		],
	},
};

// =============================================================================
// PLUGIN FACTORY
// =============================================================================

export function scheduledTransactions(options?: ScheduledTransactionsOptions): SummaPlugin {
	const maxRetries = options?.maxRetries ?? 3;
	const batchSize = options?.batchSize ?? 100;
	const maxBatchesPerRun = options?.maxBatchesPerRun ?? 50;

	return {
		id: "scheduled-transactions",

		schema: scheduledTransactionSchema,

		$Infer: {} as {
			ScheduledTransaction: ScheduledTransaction;
		},

		endpoints: [
			// POST /scheduled-transactions — Create a scheduled transaction
			{
				method: "POST",
				path: "/scheduled-transactions",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const body = req.body as Record<string, unknown> | null;
					if (!body || typeof body !== "object")
						return json(400, {
							error: { code: "INVALID_ARGUMENT", message: "Request body required" },
						});

					const sourceIdentifier = body.sourceIdentifier as string | undefined;
					const amount = body.amount as number | undefined;
					const scheduledFor = body.scheduledFor as string | undefined;

					if (!sourceIdentifier)
						return json(400, {
							error: { code: "INVALID_ARGUMENT", message: "sourceIdentifier is required" },
						});
					if (amount == null || typeof amount !== "number" || amount <= 0)
						return json(400, {
							error: {
								code: "INVALID_ARGUMENT",
								message: "amount must be a positive number",
							},
						});
					if (!scheduledFor)
						return json(400, {
							error: { code: "INVALID_ARGUMENT", message: "scheduledFor is required" },
						});

					const result = await createScheduledTransactionRecord(ctx, {
						sourceIdentifier,
						destinationIdentifier: (body.destinationIdentifier as string) ?? null,
						amount,
						currency: body.currency as string | undefined,
						scheduledFor,
						reference: body.reference as string | undefined,
						recurrence: body.recurrence as RecurrenceInput | undefined,
					});
					return json(201, result);
				},
			},

			// GET /scheduled-transactions/:id — Get a scheduled transaction
			{
				method: "GET",
				path: "/scheduled-transactions/:id",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const id = req.params.id ?? "";
					const result = await getScheduledTransactionRecord(ctx, id);
					return json(200, result);
				},
			},

			// GET /scheduled-transactions — List scheduled transactions
			{
				method: "GET",
				path: "/scheduled-transactions",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const result = await listScheduledTransactionRecords(ctx, {
						status: req.query.status as ScheduledTransactionStatus | undefined,
						sourceIdentifier: req.query.sourceIdentifier,
						limit: req.query.limit ? Number(req.query.limit) : undefined,
						offset: req.query.offset ? Number(req.query.offset) : undefined,
					});
					return json(200, result);
				},
			},

			// POST /scheduled-transactions/:id/cancel — Cancel a scheduled transaction
			{
				method: "POST",
				path: "/scheduled-transactions/:id/cancel",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const id = req.params.id ?? "";
					const body = req.body as Record<string, unknown> | null;
					const reason = (body?.reason as string) ?? undefined;
					const result = await cancelScheduledTransactionRecord(ctx, id, reason);
					return json(200, result);
				},
			},
		],

		workers: [
			{
				id: "scheduled-processor",
				description: "Processes scheduled transactions that are due for execution",
				interval: "1m",
				leaseRequired: true,
				handler: async (ctx: SummaContext) => {
					await processScheduledTransactions(ctx, {
						maxRetries,
						batchSize,
						maxBatchesPerRun,
					});
				},
			},
		],
	};
}

// =============================================================================
// CREATE SCHEDULED TRANSACTION
// =============================================================================

async function createScheduledTransactionRecord(
	ctx: SummaContext,
	params: CreateScheduledTransactionParams,
): Promise<ScheduledTransaction> {
	const t = createTableResolver(ctx.options.schema);
	const d = ctx.dialect;
	const ledgerId = getLedgerId(ctx);

	const { sourceIdentifier, destinationIdentifier, amount, scheduledFor, reference, recurrence } =
		params;
	const currency = params.currency ?? ctx.options.currency;

	// Validate amount
	if (amount <= 0) {
		throw SummaError.invalidArgument("amount must be a positive number");
	}

	// Validate identifier routing
	const sourceIsSystem = isSystemAccount(sourceIdentifier);
	const destIsSystem =
		destinationIdentifier != null ? isSystemAccount(destinationIdentifier) : true;
	if (sourceIsSystem && destIsSystem && destinationIdentifier != null) {
		throw SummaError.invalidArgument(
			"System-to-system transfers are not supported. At least one side must be a holder.",
		);
	}

	// Validate recurrence
	if (recurrence) {
		if (typeof recurrence.intervalMs !== "number" || recurrence.intervalMs <= 0) {
			throw SummaError.invalidArgument("recurrence.intervalMs must be a positive number");
		}
		if (
			recurrence.maxExecutions != null &&
			(typeof recurrence.maxExecutions !== "number" || recurrence.maxExecutions <= 0)
		) {
			throw SummaError.invalidArgument(
				"recurrence.maxExecutions must be a positive number if provided",
			);
		}
	}

	const scheduledForIso = scheduledFor instanceof Date ? scheduledFor.toISOString() : scheduledFor;

	const row = await withTransactionTimeout(ctx, async (tx) => {
		// Insert the scheduled transaction row
		const rows = await tx.raw<RawScheduledInsertRow>(
			`INSERT INTO ${t("scheduled_transaction")} (
				id, reference, amount, currency,
				source_identifier, destination_identifier,
				scheduled_for, recurrence, status,
				execution_count, retry_count,
				next_execution_at, ledger_id
			) VALUES (
				${d.generateUuid()}, $1, $2, $3,
				$4, $5,
				$6, $7, 'scheduled',
				0, 0,
				$6, $8
			) RETURNING *`,
			[
				reference ?? null,
				amount,
				currency,
				sourceIdentifier,
				destinationIdentifier ?? null,
				scheduledForIso,
				recurrence ? JSON.stringify(recurrence) : null,
				ledgerId,
			],
		);

		const row = rows[0];
		if (!row) throw SummaError.internal("Failed to create scheduled transaction");

		// Initialize entity status
		await initializeEntityStatus(tx, ENTITY_TYPE, row.id, "scheduled", {
			execution_count: 0,
			retry_count: 0,
			last_executed_at: null,
			next_execution_at: scheduledForIso,
			last_retry_at: null,
		});

		return row;
	});

	return rawToScheduledTransaction(row, "scheduled", {
		execution_count: 0,
		retry_count: 0,
		last_executed_at: null,
		next_execution_at: scheduledForIso,
		last_retry_at: null,
	});
}

// =============================================================================
// GET SCHEDULED TRANSACTION
// =============================================================================

async function getScheduledTransactionRecord(
	ctx: SummaContext,
	scheduledId: string,
): Promise<ScheduledTransaction> {
	const t = createTableResolver(ctx.options.schema);
	const ledgerId = getLedgerId(ctx);

	const rows = await ctx.adapter.raw<
		RawScheduledInsertRow & { esl_status: string; esl_metadata: Record<string, unknown> | null }
	>(
		`SELECT st.*, latest.status AS esl_status, latest.metadata AS esl_metadata
		 FROM ${t("scheduled_transaction")} st
		 LEFT JOIN LATERAL (
			SELECT esl.status, esl.metadata
			FROM ${t("entity_status_log")} esl
			WHERE esl.entity_type = '${ENTITY_TYPE}'
			  AND esl.entity_id = st.id
			ORDER BY esl.created_at DESC
			LIMIT 1
		 ) latest ON true
		 WHERE st.id = $1 AND st.ledger_id = $2`,
		[scheduledId, ledgerId],
	);

	const row = rows[0];
	if (!row) throw SummaError.notFound("Scheduled transaction not found");

	return rawToScheduledTransaction(
		row,
		(row.esl_status ?? row.status) as ScheduledTransactionStatus,
		row.esl_metadata,
	);
}

// =============================================================================
// LIST SCHEDULED TRANSACTIONS
// =============================================================================

async function listScheduledTransactionRecords(
	ctx: SummaContext,
	params?: {
		status?: ScheduledTransactionStatus;
		sourceIdentifier?: string;
		limit?: number;
		offset?: number;
	},
): Promise<ScheduledTransaction[]> {
	const t = createTableResolver(ctx.options.schema);
	const ledgerId = getLedgerId(ctx);
	const limit = params?.limit ?? 50;
	const offset = params?.offset ?? 0;

	const conditions: string[] = ["st.ledger_id = $1"];
	const values: unknown[] = [ledgerId];
	let paramIdx = 2;

	if (params?.status) {
		conditions.push(`latest.status = $${paramIdx}`);
		values.push(params.status);
		paramIdx++;
	}

	if (params?.sourceIdentifier) {
		conditions.push(`st.source_identifier = $${paramIdx}`);
		values.push(params.sourceIdentifier);
		paramIdx++;
	}

	values.push(limit, offset);

	const rows = await ctx.adapter.raw<
		RawScheduledInsertRow & { esl_status: string; esl_metadata: Record<string, unknown> | null }
	>(
		`SELECT st.*, latest.status AS esl_status, latest.metadata AS esl_metadata
		 FROM ${t("scheduled_transaction")} st
		 LEFT JOIN LATERAL (
			SELECT esl.status, esl.metadata
			FROM ${t("entity_status_log")} esl
			WHERE esl.entity_type = '${ENTITY_TYPE}'
			  AND esl.entity_id = st.id
			ORDER BY esl.created_at DESC
			LIMIT 1
		 ) latest ON true
		 WHERE ${conditions.join(" AND ")}
		 ORDER BY st.scheduled_for ASC
		 LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
		values,
	);

	return rows.map((row) =>
		rawToScheduledTransaction(
			row,
			(row.esl_status ?? row.status) as ScheduledTransactionStatus,
			row.esl_metadata,
		),
	);
}

// =============================================================================
// CANCEL SCHEDULED TRANSACTION
// =============================================================================

async function cancelScheduledTransactionRecord(
	ctx: SummaContext,
	scheduledId: string,
	reason?: string,
): Promise<ScheduledTransaction> {
	const t = createTableResolver(ctx.options.schema);
	const ledgerId = getLedgerId(ctx);

	return withTransactionTimeout(ctx, async (tx) => {
		// Fetch and lock the row
		const rows = await tx.raw<RawScheduledInsertRow>(
			`SELECT st.*
			 FROM ${t("scheduled_transaction")} st
			 WHERE st.id = $1 AND st.ledger_id = $2
			 ${ctx.dialect.forUpdateSkipLocked()}`,
			[scheduledId, ledgerId],
		);

		const row = rows[0];
		if (!row) throw SummaError.notFound("Scheduled transaction not found");

		// Verify current status is cancellable
		const currentStatus = await getEntityStatus(tx, ENTITY_TYPE, scheduledId);
		if (!currentStatus || !["scheduled"].includes(currentStatus.status)) {
			throw SummaError.conflict(
				`Cannot cancel scheduled transaction in status "${currentStatus?.status ?? "unknown"}"`,
			);
		}

		// Transition to cancelled
		await transitionEntityStatus({
			tx,
			entityType: ENTITY_TYPE,
			entityId: scheduledId,
			status: "cancelled",
			expectedCurrentStatus: "scheduled",
			reason: reason ?? "Cancelled by user",
			metadata: {
				...(currentStatus.metadata ?? {}),
				next_execution_at: null,
			},
		});

		return rawToScheduledTransaction(row, "cancelled", {
			...(currentStatus.metadata ?? {}),
			next_execution_at: null,
		});
	});
}

// =============================================================================
// ROW MAPPER
// =============================================================================

function rawToScheduledTransaction(
	row: RawScheduledInsertRow,
	status: ScheduledTransactionStatus,
	metadata: Record<string, unknown> | null,
): ScheduledTransaction {
	const rec = parseRecurrence(row.recurrence);
	return {
		id: row.id,
		reference: row.reference,
		amount: Number(row.amount),
		currency: row.currency,
		sourceIdentifier: row.source_identifier,
		destinationIdentifier: row.destination_identifier,
		scheduledFor: new Date(row.scheduled_for).toISOString(),
		recurrence: rec,
		status,
		executionCount: Number(metadata?.execution_count ?? row.execution_count ?? 0),
		retryCount: Number(metadata?.retry_count ?? row.retry_count ?? 0),
		lastExecutedAt: metadata?.last_executed_at
			? String(metadata.last_executed_at)
			: row.last_executed_at
				? new Date(row.last_executed_at).toISOString()
				: null,
		nextExecutionAt: metadata?.next_execution_at
			? String(metadata.next_execution_at)
			: row.next_execution_at
				? new Date(row.next_execution_at).toISOString()
				: null,
		createdAt: new Date(row.created_at).toISOString(),
	};
}

// =============================================================================
// PUBLIC API EXPORTS
// =============================================================================

export { createScheduledTransactionRecord as createScheduledTransaction };
export { getScheduledTransactionRecord as getScheduledTransaction };
export { listScheduledTransactionRecords as listScheduledTransactions };
export { cancelScheduledTransactionRecord as cancelScheduledTransaction };

// =============================================================================
// PROCESS SCHEDULED TRANSACTIONS
// =============================================================================

async function processScheduledTransactions(
	ctx: SummaContext,
	options: Required<ScheduledTransactionsOptions>,
): Promise<void> {
	const t = createTableResolver(ctx.options.schema);
	const ledgerId = getLedgerId(ctx);
	const { maxRetries, batchSize, maxBatchesPerRun } = options;

	for (let batch = 0; batch < maxBatchesPerRun; batch++) {
		const now = new Date().toISOString();

		// Fetch candidate IDs using a LATERAL JOIN to entity_status_log.
		// The sub-select finds the latest status row for each scheduled_transaction
		// and filters to those that are 'scheduled' with next_execution_at in the
		// metadata that has passed.
		const candidates = await ctx.adapter.raw<RawScheduledRow>(
			`SELECT st.id
       FROM ${t("scheduled_transaction")} st
       INNER JOIN LATERAL (
         SELECT esl.status, esl.metadata
         FROM ${t("entity_status_log")} esl
         WHERE esl.entity_type = '${ENTITY_TYPE}'
           AND esl.entity_id = st.id
         ORDER BY esl.created_at DESC
         LIMIT 1
       ) latest_status ON true
       WHERE st.ledger_id = $1
         AND latest_status.status = 'scheduled'
         AND (latest_status.metadata->>'next_execution_at')::timestamptz <= $2::timestamptz
       ORDER BY (latest_status.metadata->>'next_execution_at')::timestamptz ASC
       LIMIT $3`,
			[ledgerId, now, batchSize],
		);

		if (candidates.length === 0) {
			break;
		}

		for (const candidate of candidates) {
			await processSingleScheduledTransaction(ctx, candidate.id, maxRetries);
		}
	}
}

// =============================================================================
// PROCESS SINGLE SCHEDULED TRANSACTION (3-phase)
// =============================================================================

async function processSingleScheduledTransaction(
	ctx: SummaContext,
	scheduledId: string,
	maxRetries: number,
): Promise<void> {
	const t = createTableResolver(ctx.options.schema);
	// -------------------------------------------------------------------------
	// Phase 1: Lock row, mark as processing
	// -------------------------------------------------------------------------
	let detail: RawScheduledDetailRow | null = null;

	try {
		detail = await withTransactionTimeout(ctx, async (tx) => {
			// Lock the scheduled_transaction row and join to latest status
			const rows = await tx.raw<RawScheduledDetailRow>(
				`SELECT st.id, st.reference, st.amount, st.currency,
                st.source_identifier, st.destination_identifier,
                st.scheduled_for, st.recurrence,
                latest_status.status AS current_status,
                latest_status.metadata AS status_metadata
         FROM ${t("scheduled_transaction")} st
         INNER JOIN LATERAL (
           SELECT esl.status, esl.metadata
           FROM ${t("entity_status_log")} esl
           WHERE esl.entity_type = '${ENTITY_TYPE}'
             AND esl.entity_id = st.id
           ORDER BY esl.created_at DESC
           LIMIT 1
         ) latest_status ON true
         WHERE st.id = $1 AND latest_status.status = 'scheduled'
         ${ctx.dialect.forUpdateSkipLocked()}`,
				[scheduledId],
			);

			const row = rows[0];
			if (!row) {
				// Already picked up by another worker or no longer scheduled
				return null;
			}

			// Transition to processing
			await transitionEntityStatus({
				tx,
				entityType: ENTITY_TYPE,
				entityId: scheduledId,
				status: "processing",
				expectedCurrentStatus: "scheduled",
				metadata: row.status_metadata ?? undefined,
			});

			return row;
		});
	} catch (error) {
		ctx.logger.error("Phase 1 failed for scheduled transaction", {
			scheduledId,
			error: error instanceof Error ? error.message : String(error),
		});
		return;
	}

	if (!detail) {
		return;
	}

	// Extract mutable fields from status metadata
	const statusMeta = detail.status_metadata ?? {};
	const executionCount = Number(statusMeta.execution_count ?? 0);
	const retryCount = Number(statusMeta.retry_count ?? 0);

	// -------------------------------------------------------------------------
	// Phase 2: Execute the financial operation
	// -------------------------------------------------------------------------
	try {
		await executeScheduledTransaction(ctx, {
			amount: Number(detail.amount),
			currency: detail.currency,
			sourceIdentifier: detail.source_identifier,
			destinationIdentifier: detail.destination_identifier,
			reference: detail.reference ?? `scheduled-${scheduledId}-${Date.now()}`,
			scheduledId,
		});
	} catch (error) {
		// Execution failed -- handle retry or permanent failure
		await handleExecutionFailure(ctx, scheduledId, detail, maxRetries, error, {
			executionCount,
			retryCount,
		});
		return;
	}

	// -------------------------------------------------------------------------
	// Phase 3: Mark completed or rescheduled
	// -------------------------------------------------------------------------
	try {
		await withTransactionTimeout(ctx, async (tx) => {
			const recurrence = parseRecurrence(detail.recurrence);
			const newExecutionCount = executionCount + 1;
			const now = new Date();

			if (recurrence && shouldReschedule(recurrence, newExecutionCount)) {
				// Compute next execution time
				const nextExecution = computeNextExecution(now, recurrence);

				// Transition back to scheduled with updated metadata
				await transitionEntityStatus({
					tx,
					entityType: ENTITY_TYPE,
					entityId: scheduledId,
					status: "scheduled",
					expectedCurrentStatus: "processing",
					reason: "rescheduled",
					metadata: {
						execution_count: newExecutionCount,
						retry_count: 0,
						last_executed_at: now.toISOString(),
						next_execution_at: nextExecution.toISOString(),
						last_retry_at: null,
					},
				});

				ctx.logger.info("Scheduled transaction rescheduled", {
					scheduledId,
					executionCount: newExecutionCount,
					nextExecutionAt: nextExecution.toISOString(),
				});
			} else {
				// One-shot or max executions reached -- mark completed
				await transitionEntityStatus({
					tx,
					entityType: ENTITY_TYPE,
					entityId: scheduledId,
					status: "completed",
					expectedCurrentStatus: "processing",
					metadata: {
						execution_count: newExecutionCount,
						retry_count: 0,
						last_executed_at: now.toISOString(),
						next_execution_at: null,
						last_retry_at: null,
					},
				});

				ctx.logger.info("Scheduled transaction completed", {
					scheduledId,
					executionCount: newExecutionCount,
				});
			}
		});
	} catch (error) {
		// Phase 3 failure: the financial operation succeeded but we could not
		// update the status. Log prominently so operators can reconcile.
		ctx.logger.error(
			"Phase 3 failed for scheduled transaction -- manual reconciliation may be required",
			{
				scheduledId,
				error: error instanceof Error ? error.message : String(error),
			},
		);
	}
}

// =============================================================================
// EXECUTION FAILURE HANDLER
// =============================================================================

async function handleExecutionFailure(
	ctx: SummaContext,
	scheduledId: string,
	detail: RawScheduledDetailRow,
	maxRetries: number,
	error: unknown,
	counters: { executionCount: number; retryCount: number },
): Promise<void> {
	const errorMessage = error instanceof Error ? error.message : String(error);
	const currentRetryCount = counters.retryCount + 1;
	const nowIso = new Date().toISOString();

	try {
		await withTransactionTimeout(ctx, async (tx) => {
			if (currentRetryCount >= maxRetries) {
				// Max retries exceeded -- mark as failed permanently
				await transitionEntityStatus({
					tx,
					entityType: ENTITY_TYPE,
					entityId: scheduledId,
					status: "failed",
					expectedCurrentStatus: "processing",
					reason: errorMessage,
					metadata: {
						execution_count: counters.executionCount,
						retry_count: currentRetryCount,
						last_executed_at:
							(detail.status_metadata as Record<string, unknown>)?.last_executed_at ?? null,
						next_execution_at: null,
						last_retry_at: nowIso,
					},
				});

					ctx.logger.error("Scheduled transaction permanently failed", {
					scheduledId,
					retryCount: currentRetryCount,
					error: errorMessage,
				});
			} else {
				// Revert to scheduled for retry on next run
				await transitionEntityStatus({
					tx,
					entityType: ENTITY_TYPE,
					entityId: scheduledId,
					status: "scheduled",
					expectedCurrentStatus: "processing",
					reason: `retry ${currentRetryCount}/${maxRetries}: ${errorMessage}`,
					metadata: {
						execution_count: counters.executionCount,
						retry_count: currentRetryCount,
						last_executed_at:
							(detail.status_metadata as Record<string, unknown>)?.last_executed_at ?? null,
						next_execution_at:
							(detail.status_metadata as Record<string, unknown>)?.next_execution_at ?? null,
						last_retry_at: nowIso,
					},
				});

				ctx.logger.info("Scheduled transaction execution failed, will retry", {
					scheduledId,
					retryCount: currentRetryCount,
					maxRetries,
					error: errorMessage,
				});
			}
		});
	} catch (updateError) {
		ctx.logger.error("Failed to update scheduled transaction after execution failure", {
			scheduledId,
			originalError: errorMessage,
			updateError: updateError instanceof Error ? updateError.message : String(updateError),
		});
	}
}

// =============================================================================
// EXECUTE SCHEDULED TRANSACTION
// =============================================================================
// Routes the scheduled transaction to the appropriate financial operation
// based on identifier prefixes:
//   - "@" prefix = system account
//   - "holderId:holderType" format = user account
//   - System source + user dest -> creditAccount
//   - User source + system dest -> debitAccount
//   - User source + user dest -> transfer

interface ExecuteParams {
	amount: number;
	currency: string;
	sourceIdentifier: string;
	destinationIdentifier: string | null;
	reference: string;
	scheduledId: string;
}

async function executeScheduledTransaction(
	ctx: SummaContext,
	params: ExecuteParams,
): Promise<void> {
	const { amount, sourceIdentifier, destinationIdentifier, reference, scheduledId } = params;

	const sourceIsSystem = isSystemAccount(sourceIdentifier);
	const destIsSystem = destinationIdentifier ? isSystemAccount(destinationIdentifier) : true; // No destination defaults to system-like behavior

	if (sourceIsSystem && !destIsSystem && destinationIdentifier) {
		// System source + user dest -> credit the user account
		const dest = parseUserIdentifier(destinationIdentifier);
		await creditAccount(ctx, {
			holderId: dest.holderId,
			amount,
			reference,
			sourceSystemAccount: sourceIdentifier,
			description: `Scheduled transaction ${scheduledId}`,
		});
	} else if (!sourceIsSystem && (destIsSystem || !destinationIdentifier)) {
		// User source + system dest (or no dest) -> debit the user account
		const source = parseUserIdentifier(sourceIdentifier);
		await debitAccount(ctx, {
			holderId: source.holderId,
			amount,
			reference,
			destinationSystemAccount: destinationIdentifier ?? undefined,
			description: `Scheduled transaction ${scheduledId}`,
		});
	} else if (!sourceIsSystem && !destIsSystem && destinationIdentifier) {
		// User source + user dest -> transfer between accounts
		const source = parseUserIdentifier(sourceIdentifier);
		const dest = parseUserIdentifier(destinationIdentifier);
		await transfer(ctx, {
			sourceHolderId: source.holderId,
			destinationHolderId: dest.holderId,
			amount,
			reference,
			description: `Scheduled transaction ${scheduledId}`,
		});
	} else {
		// System-to-system: not a valid user-facing operation
		throw SummaError.invalidArgument(
			`Unsupported scheduled transaction route: source=${sourceIdentifier}, destination=${destinationIdentifier}`,
		);
	}
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Check if an identifier represents a system account.
 * System accounts are prefixed with "@" (e.g., "@World", "@Fees").
 */
function isSystemAccount(identifier: string): boolean {
	return identifier.startsWith("@");
}

/**
 * Parse a user identifier in "holderId:holderType" format.
 * Falls back to treating the entire string as holderId if no colon present.
 */
function parseUserIdentifier(identifier: string): {
	holderId: string;
	holderType: string | undefined;
} {
	const colonIndex = identifier.indexOf(":");
	if (colonIndex === -1) {
		return { holderId: identifier, holderType: undefined };
	}
	return {
		holderId: identifier.substring(0, colonIndex),
		holderType: identifier.substring(colonIndex + 1),
	};
}

/**
 * Compute the next execution date by adding the recurrence interval.
 */
function computeNextExecution(fromDate: Date, recurrence: Recurrence): Date {
	return new Date(fromDate.getTime() + recurrence.intervalMs);
}

/**
 * Parse a recurrence value from the database (may be JSONB object or string).
 */
function parseRecurrence(raw: Recurrence | string | null | undefined): Recurrence | null {
	if (!raw) {
		return null;
	}
	if (typeof raw === "string") {
		try {
			const parsed = JSON.parse(raw) as Recurrence;
			if (typeof parsed.intervalMs === "number" && parsed.intervalMs > 0) {
				return parsed;
			}
			return null;
		} catch {
			return null;
		}
	}
	if (typeof raw.intervalMs === "number" && raw.intervalMs > 0) {
		return raw;
	}
	return null;
}

/**
 * Determine if a recurring transaction should be rescheduled based on
 * execution count vs. maxExecutions limit.
 */
function shouldReschedule(recurrence: Recurrence, executionCount: number): boolean {
	if (recurrence.maxExecutions != null && executionCount >= recurrence.maxExecutions) {
		return false;
	}
	return true;
}
