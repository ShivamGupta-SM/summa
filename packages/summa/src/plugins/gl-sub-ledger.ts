// =============================================================================
// GL / SUB-LEDGER PLUGIN -- General Ledger and Sub-Ledger separation
// =============================================================================
// Sub-ledger detail auto-summarizes into GL. Depends on Feature 1 for hierarchy.

import type { PluginApiRequest, PluginApiResponse, SummaContext, SummaPlugin } from "@summa/core";
import { createTableResolver } from "@summa/core/db";

// =============================================================================
// TYPES
// =============================================================================

export interface GlSubLedgerOptions {
	/** Reconciliation check interval. Default: "1h" */
	reconcileInterval?: string;
}

export interface GlSummary {
	glAccountId: string;
	totalBalance: number;
	totalCreditBalance: number;
	totalDebitBalance: number;
	subLedgerCount: number;
}

export interface ReconciliationResult {
	glAccountId: string;
	glBalance: number;
	subLedgerSum: number;
	balanced: boolean;
	difference: number;
}

function jsonRes(status: number, body: unknown): PluginApiResponse {
	return { status, body };
}

// =============================================================================
// CORE OPERATIONS
// =============================================================================

export async function registerSubLedger(
	ctx: SummaContext,
	params: { glAccountId: string; subLedgerAccountIds: string[] },
): Promise<void> {
	const t = createTableResolver(ctx.options.schema);
	for (const subId of params.subLedgerAccountIds) {
		await ctx.adapter.raw(
			`INSERT INTO ${t("gl_sub_ledger_mapping")} (gl_account_id, sub_ledger_account_id)
       VALUES ($1, $2)
       ON CONFLICT (gl_account_id, sub_ledger_account_id) DO NOTHING`,
			[params.glAccountId, subId],
		);
	}
}

export async function getGlSummary(ctx: SummaContext, glAccountId: string): Promise<GlSummary> {
	const t = createTableResolver(ctx.options.schema);
	const rows = await ctx.adapter.raw<{
		total_balance: number;
		total_credit: number;
		total_debit: number;
		count: number;
	}>(
		`SELECT
       COALESCE(SUM(ab.balance), 0) as total_balance,
       COALESCE(SUM(ab.credit_balance), 0) as total_credit,
       COALESCE(SUM(ab.debit_balance), 0) as total_debit,
       COUNT(*)::int as count
     FROM ${t("account_balance")} ab
     JOIN ${t("gl_sub_ledger_mapping")} m ON m.sub_ledger_account_id = ab.id
     WHERE m.gl_account_id = $1`,
		[glAccountId],
	);

	const row = rows[0];
	return {
		glAccountId,
		totalBalance: Number(row?.total_balance ?? 0),
		totalCreditBalance: Number(row?.total_credit ?? 0),
		totalDebitBalance: Number(row?.total_debit ?? 0),
		subLedgerCount: Number(row?.count ?? 0),
	};
}

export async function reconcile(
	ctx: SummaContext,
	glAccountId?: string,
): Promise<ReconciliationResult[]> {
	const t = createTableResolver(ctx.options.schema);
	const filter = glAccountId ? `WHERE m.gl_account_id = $1` : "";
	const params = glAccountId ? [glAccountId] : [];

	const rows = await ctx.adapter.raw<{
		gl_account_id: string;
		gl_balance: number;
		sub_sum: number;
	}>(
		`SELECT
       m.gl_account_id,
       gl.balance as gl_balance,
       COALESCE(SUM(sub.balance), 0) as sub_sum
     FROM ${t("gl_sub_ledger_mapping")} m
     JOIN ${t("account_balance")} gl ON gl.id = m.gl_account_id
     JOIN ${t("account_balance")} sub ON sub.id = m.sub_ledger_account_id
     ${filter}
     GROUP BY m.gl_account_id, gl.balance`,
		params,
	);

	return rows.map((r) => ({
		glAccountId: r.gl_account_id,
		glBalance: Number(r.gl_balance),
		subLedgerSum: Number(r.sub_sum),
		balanced: Number(r.gl_balance) === Number(r.sub_sum),
		difference: Number(r.gl_balance) - Number(r.sub_sum),
	}));
}

// =============================================================================
// PLUGIN FACTORY
// =============================================================================

export function glSubLedger(options?: GlSubLedgerOptions): SummaPlugin {
	return {
		id: "gl-sub-ledger",

		schema: {
			gl_sub_ledger_mapping: {
				columns: {
					id: { type: "uuid", primaryKey: true },
					gl_account_id: {
						type: "uuid",
						notNull: true,
						references: { table: "account_balance", column: "id" },
					},
					sub_ledger_account_id: {
						type: "uuid",
						notNull: true,
						references: { table: "account_balance", column: "id" },
					},
					created_at: { type: "timestamp", default: "NOW()" },
				},
				indexes: [
					{
						name: "uq_gl_sub_ledger_mapping",
						columns: ["gl_account_id", "sub_ledger_account_id"],
						unique: true,
					},
				],
			},
		},

		workers: [
			{
				id: "gl-reconciliation",
				description: "Verify GL balance matches sum of sub-ledger balances",
				interval: options?.reconcileInterval ?? "1h",
				leaseRequired: true,
				handler: async (ctx) => {
					const results = await reconcile(ctx);
					const mismatches = results.filter((r) => !r.balanced);
					if (mismatches.length > 0) {
						ctx.logger.warn("GL reconciliation mismatches found", {
							count: mismatches.length,
							mismatches,
						});
					}
				},
			},
		],

		endpoints: [
			{
				method: "POST",
				path: "/gl/mapping",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const body = req.body as { glAccountId: string; subLedgerAccountIds: string[] };
					if (!body.glAccountId || !body.subLedgerAccountIds?.length) {
						return jsonRes(400, {
							error: {
								code: "VALIDATION_ERROR",
								message: "glAccountId and subLedgerAccountIds required",
							},
						});
					}
					await registerSubLedger(ctx, body);
					return jsonRes(201, { ok: true });
				},
			},
			{
				method: "GET",
				path: "/gl/:accountId/summary",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const summary = await getGlSummary(ctx, req.params.accountId ?? "");
					return jsonRes(200, summary);
				},
			},
			{
				method: "GET",
				path: "/gl/reconcile",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const results = await reconcile(ctx, req.query.glAccountId);
					return jsonRes(200, results);
				},
			},
		],
	};
}
