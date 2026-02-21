// =============================================================================
// PERIOD CLOSE PLUGIN -- Accounting period management
// =============================================================================
// Accounting periods must be lockable. Once a period is closed, no transactions
// should post to that period. Required for compliance and immutable reports.
//
// Status is tracked via entity_status_log (append-only), NOT a status column
// on the accounting_period table. The entity type is "accounting_period".

import type { PluginApiRequest, PluginApiResponse, SummaContext, SummaPlugin } from "@summa/core";
import { SummaError } from "@summa/core";
import { createTableResolver } from "@summa/core/db";
import {
	initializeEntityStatus,
	transitionEntityStatus,
} from "../../infrastructure/entity-status.js";

// =============================================================================
// TYPES
// =============================================================================

const ENTITY_TYPE = "accounting_period" as const;

export interface PeriodCloseOptions {
	/** Base path for period-close endpoints. Default: "/periods" */
	basePath?: string;
}

export interface AccountingPeriod {
	id: string;
	name: string;
	startDate: string;
	endDate: string;
	status: "open" | "closing" | "closed" | "locked";
	closedBy: string | null;
	closedAt: string | null;
	reopenedCount: number;
	createdAt: string;
}

/**
 * Raw row shape from the LATERAL JOIN query that merges the accounting_period
 * base row with the latest entity_status_log entry.
 */
interface RawPeriodRow {
	id: string;
	name: string;
	start_date: string | Date;
	end_date: string | Date;
	status: string;
	metadata: Record<string, unknown> | null;
	created_at: string | Date;
}

// =============================================================================
// HELPERS
// =============================================================================

function rawToPeriod(row: RawPeriodRow): AccountingPeriod {
	const meta = row.metadata ?? {};
	return {
		id: row.id,
		name: row.name,
		startDate:
			row.start_date instanceof Date ? row.start_date.toISOString() : String(row.start_date),
		endDate: row.end_date instanceof Date ? row.end_date.toISOString() : String(row.end_date),
		status: row.status as AccountingPeriod["status"],
		closedBy: (meta.closed_by as string) ?? null,
		closedAt: (meta.closed_at as string) ?? null,
		reopenedCount: (meta.reopened_count as number) ?? 0,
		createdAt:
			row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
	};
}

function jsonRes(status: number, body: unknown): PluginApiResponse {
	return { status, body };
}

/**
 * Build the FROM + LATERAL JOIN fragment that resolves the current status for
 * each accounting_period row from entity_status_log.
 *
 * Returns SQL of the form:
 *   <accounting_period> ap
 *   CROSS JOIN LATERAL (
 *     SELECT status, metadata FROM <entity_status_log>
 *     WHERE entity_type = 'accounting_period' AND entity_id = ap.id::text
 *     ORDER BY created_at DESC LIMIT 1
 *   ) esl
 */
function periodWithStatusFrom(t: ReturnType<typeof createTableResolver>): string {
	return `${t("accounting_period")} ap
    CROSS JOIN LATERAL (
      SELECT status, metadata
      FROM ${t("entity_status_log")}
      WHERE entity_type = '${ENTITY_TYPE}' AND entity_id = ap.id::text
      ORDER BY created_at DESC
      LIMIT 1
    ) esl`;
}

// =============================================================================
// CORE OPERATIONS
// =============================================================================

async function listPeriods(ctx: SummaContext): Promise<AccountingPeriod[]> {
	const t = createTableResolver(ctx.options.schema);
	const rows = await ctx.adapter.raw<RawPeriodRow>(
		`SELECT ap.id, ap.name, ap.start_date, ap.end_date, ap.metadata, ap.created_at,
            esl.status
     FROM ${periodWithStatusFrom(t)}
     ORDER BY ap.start_date DESC`,
		[],
	);
	return rows.map(rawToPeriod);
}

async function createPeriod(
	ctx: SummaContext,
	params: { name: string; startDate: string; endDate: string },
): Promise<AccountingPeriod> {
	const t = createTableResolver(ctx.options.schema);

	return ctx.adapter.transaction(async (tx) => {
		const rows = await tx.raw<RawPeriodRow>(
			`INSERT INTO ${t("accounting_period")} (name, start_date, end_date, metadata)
       VALUES ($1, $2::timestamptz, $3::timestamptz, '{}')
       RETURNING *`,
			[params.name, params.startDate, params.endDate],
		);
		const row = rows[0];
		if (!row) throw SummaError.internal("Failed to create accounting period");

		await initializeEntityStatus(tx, ENTITY_TYPE, row.id, "open");

		// Re-query with LATERAL JOIN to return the full shape
		const fullRows = await tx.raw<RawPeriodRow>(
			`SELECT ap.id, ap.name, ap.start_date, ap.end_date, ap.metadata, ap.created_at,
              esl.status
       FROM ${periodWithStatusFrom(t)}
       WHERE ap.id = $1`,
			[row.id],
		);
		const full = fullRows[0];
		if (!full) throw SummaError.internal("Failed to read back created period");
		return rawToPeriod(full);
	});
}

async function closePeriod(
	ctx: SummaContext,
	params: { periodId: string; closedBy: string },
): Promise<AccountingPeriod> {
	const t = createTableResolver(ctx.options.schema);

	return ctx.adapter.transaction(async (tx) => {
		// Lock the period row to prevent concurrent mutations
		const lockRows = await tx.raw<{ id: string }>(
			`SELECT id FROM ${t("accounting_period")} WHERE id = $1 FOR UPDATE`,
			[params.periodId],
		);
		if (lockRows.length === 0) {
			throw SummaError.conflict("Period not found");
		}

		const closedAt = new Date().toISOString();

		await transitionEntityStatus({
			tx,
			entityType: ENTITY_TYPE,
			entityId: params.periodId,
			status: "closed",
			expectedCurrentStatus: "open",
			reason: `Closed by ${params.closedBy}`,
			metadata: {
				closed_by: params.closedBy,
				closed_at: closedAt,
			},
		});

		const fullRows = await tx.raw<RawPeriodRow>(
			`SELECT ap.id, ap.name, ap.start_date, ap.end_date, ap.metadata, ap.created_at,
              esl.status
       FROM ${periodWithStatusFrom(t)}
       WHERE ap.id = $1`,
			[params.periodId],
		);
		const full = fullRows[0];
		if (!full) throw SummaError.internal("Failed to read back closed period");
		return rawToPeriod(full);
	});
}

async function reopenPeriod(
	ctx: SummaContext,
	params: { periodId: string; reopenedBy: string; reason?: string },
): Promise<AccountingPeriod> {
	const t = createTableResolver(ctx.options.schema);

	return ctx.adapter.transaction(async (tx) => {
		// Lock the period row to prevent concurrent mutations
		const lockRows = await tx.raw<{ id: string }>(
			`SELECT id FROM ${t("accounting_period")} WHERE id = $1 FOR UPDATE`,
			[params.periodId],
		);
		if (lockRows.length === 0) {
			throw SummaError.conflict("Period not found");
		}

		// Read current status metadata to compute the new reopened_count
		const latestRows = await tx.raw<{ metadata: Record<string, unknown> | null }>(
			`SELECT metadata FROM ${t("entity_status_log")}
       WHERE entity_type = $1 AND entity_id = $2
       ORDER BY created_at DESC LIMIT 1`,
			[ENTITY_TYPE, params.periodId],
		);
		const currentMeta = latestRows[0]?.metadata ?? {};
		const previousReopenedCount = (currentMeta.reopened_count as number) ?? 0;

		await transitionEntityStatus({
			tx,
			entityType: ENTITY_TYPE,
			entityId: params.periodId,
			status: "open",
			expectedCurrentStatus: "closed",
			reason: params.reason ?? `Reopened by ${params.reopenedBy}`,
			metadata: {
				reopened_by: params.reopenedBy,
				reopened_count: previousReopenedCount + 1,
			},
		});

		ctx.logger.info("Period reopened", {
			periodId: params.periodId,
			reopenedBy: params.reopenedBy,
			reason: params.reason,
		});

		const fullRows = await tx.raw<RawPeriodRow>(
			`SELECT ap.id, ap.name, ap.start_date, ap.end_date, ap.metadata, ap.created_at,
              esl.status
       FROM ${periodWithStatusFrom(t)}
       WHERE ap.id = $1`,
			[params.periodId],
		);
		const full = fullRows[0];
		if (!full) throw SummaError.internal("Failed to read back reopened period");
		return rawToPeriod(full);
	});
}

async function lockPeriod(ctx: SummaContext, periodId: string): Promise<AccountingPeriod> {
	const t = createTableResolver(ctx.options.schema);

	return ctx.adapter.transaction(async (tx) => {
		// Lock the period row to prevent concurrent mutations
		const lockRows = await tx.raw<{ id: string }>(
			`SELECT id FROM ${t("accounting_period")} WHERE id = $1 FOR UPDATE`,
			[periodId],
		);
		if (lockRows.length === 0) {
			throw SummaError.conflict("Period not found");
		}

		await transitionEntityStatus({
			tx,
			entityType: ENTITY_TYPE,
			entityId: periodId,
			status: "locked",
			expectedCurrentStatus: ["closed", "open"],
			reason: "Period permanently locked",
		});

		const fullRows = await tx.raw<RawPeriodRow>(
			`SELECT ap.id, ap.name, ap.start_date, ap.end_date, ap.metadata, ap.created_at,
              esl.status
       FROM ${periodWithStatusFrom(t)}
       WHERE ap.id = $1`,
			[periodId],
		);
		const full = fullRows[0];
		if (!full) throw SummaError.internal("Failed to read back locked period");
		return rawToPeriod(full);
	});
}

export async function isPeriodClosed(ctx: SummaContext, date: Date): Promise<boolean> {
	const t = createTableResolver(ctx.options.schema);
	const rows = await ctx.adapter.raw<{ count: number }>(
		`SELECT COUNT(*)::int as count
     FROM ${t("accounting_period")} ap
     CROSS JOIN LATERAL (
       SELECT status
       FROM ${t("entity_status_log")}
       WHERE entity_type = '${ENTITY_TYPE}' AND entity_id = ap.id::text
       ORDER BY created_at DESC
       LIMIT 1
     ) esl
     WHERE esl.status IN ('closed', 'locked')
       AND ap.start_date <= $1::timestamptz
       AND ap.end_date >= $1::timestamptz`,
		[date.toISOString()],
	);
	return (rows[0]?.count ?? 0) > 0;
}

// =============================================================================
// PLUGIN FACTORY
// =============================================================================

export function periodClose(options?: PeriodCloseOptions): SummaPlugin {
	const basePath = options?.basePath ?? "/periods";

	return {
		id: "period-close",

		schema: {
			accounting_period: {
				columns: {
					id: { type: "uuid", primaryKey: true },
					name: { type: "text", notNull: true },
					start_date: { type: "timestamp", notNull: true },
					end_date: { type: "timestamp", notNull: true },
					metadata: { type: "jsonb", default: "'{}'" },
					created_at: { type: "timestamp", default: "NOW()" },
				},
				indexes: [
					{
						name: "uq_accounting_period_dates",
						columns: ["start_date", "end_date"],
						unique: true,
					},
				],
			},
		},

		hooks: {
			beforeTransaction: async (params) => {
				const closed = await isPeriodClosed(params.ctx, new Date());
				if (closed) {
					throw SummaError.conflict("Cannot post transactions in a closed or locked period");
				}
			},
		},

		endpoints: [
			{
				method: "GET",
				path: basePath,
				handler: async (_req: PluginApiRequest, ctx: SummaContext) => {
					const periods = await listPeriods(ctx);
					return jsonRes(200, periods);
				},
			},
			{
				method: "POST",
				path: basePath,
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const body = req.body as { name: string; startDate: string; endDate: string };
					if (!body.name || !body.startDate || !body.endDate) {
						return jsonRes(400, {
							error: { code: "VALIDATION_ERROR", message: "name, startDate, endDate required" },
						});
					}
					const period = await createPeriod(ctx, body);
					return jsonRes(201, period);
				},
			},
			{
				method: "POST",
				path: `${basePath}/:id/close`,
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const body = req.body as { closedBy: string };
					if (!body.closedBy) {
						return jsonRes(400, {
							error: { code: "VALIDATION_ERROR", message: "closedBy required" },
						});
					}
					const period = await closePeriod(ctx, {
						periodId: req.params.id ?? "",
						closedBy: body.closedBy,
					});
					return jsonRes(200, period);
				},
			},
			{
				method: "POST",
				path: `${basePath}/:id/reopen`,
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const body = req.body as { reopenedBy: string; reason?: string };
					if (!body.reopenedBy) {
						return jsonRes(400, {
							error: { code: "VALIDATION_ERROR", message: "reopenedBy required" },
						});
					}
					const period = await reopenPeriod(ctx, {
						periodId: req.params.id ?? "",
						...body,
					});
					return jsonRes(200, period);
				},
			},
			{
				method: "POST",
				path: `${basePath}/:id/lock`,
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const period = await lockPeriod(ctx, req.params.id ?? "");
					return jsonRes(200, period);
				},
			},
		],
	};
}
