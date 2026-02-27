// =============================================================================
// BUDGETING & FORECASTING PLUGIN
// =============================================================================
// Budget limits per holder/category/period with beforeTransaction enforcement.
// Daily snapshot worker for trend analysis and forecasting.
//
// Schema: budget, budget_snapshot
// Hooks: beforeTransaction (enforce budget limits on debit/transfer)
// Workers: budget-snapshot (daily utilization snapshot for trends)

import type {
	PluginApiRequest,
	PluginApiResponse,
	SummaContext,
	SummaPlugin,
	TableDefinition,
} from "@summa-ledger/core";
import { SummaError } from "@summa-ledger/core";
import { createTableResolver } from "@summa-ledger/core/db";
import { getLedgerId } from "../managers/ledger-helpers.js";

// =============================================================================
// TYPES
// =============================================================================

export interface BudgetingOptions {
	/** Enforcement mode. "hard" rejects transactions, "soft" logs warning. Default: "hard" */
	enforcementMode?: "hard" | "soft";
	/** Snapshot worker interval. Default: "1d" */
	snapshotInterval?: string;
}

export type BudgetPeriod = "daily" | "weekly" | "monthly" | "quarterly" | "yearly";

export interface Budget {
	id: string;
	name: string;
	holderId: string | null;
	accountCode: string | null;
	category: string | null;
	period: BudgetPeriod;
	amount: number;
	spent: number;
	remaining: number;
	periodStart: string;
	periodEnd: string;
	enabled: boolean;
	createdAt: string;
}

export interface BudgetSnapshot {
	id: string;
	budgetId: string;
	spent: number;
	snapshotDate: string;
}

// =============================================================================
// RAW ROW TYPES
// =============================================================================

interface RawBudgetRow {
	id: string;
	name: string;
	ledger_id: string;
	holder_id: string | null;
	account_code: string | null;
	category: string | null;
	period: string;
	amount: number;
	period_start: string | Date;
	period_end: string | Date;
	enabled: boolean;
	created_at: string | Date;
}

// =============================================================================
// SCHEMA
// =============================================================================

const budgetingSchema: Record<string, TableDefinition> = {
	budget: {
		columns: {
			id: { type: "uuid", primaryKey: true, notNull: true },
			name: { type: "text", notNull: true },
			ledger_id: { type: "text", notNull: true },
			holder_id: { type: "text" },
			account_code: { type: "text" },
			category: { type: "text" },
			period: { type: "text", notNull: true },
			amount: { type: "bigint", notNull: true },
			period_start: { type: "timestamp", notNull: true },
			period_end: { type: "timestamp", notNull: true },
			enabled: { type: "boolean", notNull: true, default: "true" },
			created_at: { type: "timestamp", notNull: true, default: "NOW()" },
		},
		indexes: [
			{ name: "idx_budget_ledger", columns: ["ledger_id"] },
			{ name: "idx_budget_holder", columns: ["holder_id"] },
			{ name: "idx_budget_category", columns: ["category"] },
			{
				name: "idx_budget_period",
				columns: ["period_start", "period_end"],
			},
		],
	},
	budget_snapshot: {
		columns: {
			id: { type: "uuid", primaryKey: true, notNull: true },
			budget_id: {
				type: "uuid",
				notNull: true,
				references: { table: "budget", column: "id" },
			},
			spent: { type: "bigint", notNull: true },
			snapshot_date: {
				type: "timestamp",
				notNull: true,
				default: "NOW()",
			},
		},
		indexes: [
			{ name: "idx_budget_snapshot_budget", columns: ["budget_id"] },
			{ name: "idx_budget_snapshot_date", columns: ["snapshot_date"] },
		],
	},
};

// =============================================================================
// HELPERS
// =============================================================================

function toIso(v: string | Date): string {
	return v instanceof Date ? v.toISOString() : String(v);
}

function jsonRes(status: number, body: unknown): PluginApiResponse {
	return { status, body };
}

/** Compute total debit amount matching a budget's filters within its period. */
async function getSpentInPeriod(ctx: SummaContext, budget: RawBudgetRow): Promise<number> {
	const t = createTableResolver(ctx.options.schema);
	const conditions: string[] = [];
	const params: unknown[] = [budget.period_start, budget.period_end];
	let idx = 3;

	// Category is stored in metadata jsonb on transfer
	const needsTxnJoin = !!budget.category;
	const needsAcctJoin = !!budget.holder_id || !!budget.account_code;

	if (budget.holder_id) {
		conditions.push(`ab.holder_id = $${idx++}`);
		params.push(budget.holder_id);
	}
	if (budget.account_code) {
		conditions.push(`ab.account_code = $${idx++}`);
		params.push(budget.account_code);
	}
	if (budget.category) {
		conditions.push(`tr.metadata->>'category' = $${idx++}`);
		params.push(budget.category);
	}

	const acctJoin = needsAcctJoin ? `JOIN ${t("account")} ab ON er.account_id = ab.id` : "";
	const txnJoin = needsTxnJoin
		? `JOIN ${t("transfer")} tr ON er.transfer_id = tr.id`
		: "";
	const whereExtra = conditions.length > 0 ? ` AND ${conditions.join(" AND ")}` : "";

	const rows = await ctx.adapter.raw<{ total: number }>(
		`SELECT COALESCE(SUM(er.amount), 0) as total
		 FROM ${t("entry")} er
		 ${acctJoin} ${txnJoin}
		 WHERE er.entry_type = 'DEBIT'
		   AND er.created_at >= $1::timestamptz
		   AND er.created_at <= $2::timestamptz
		   ${whereExtra}`,
		params,
	);

	return Number(rows[0]?.total ?? 0);
}

function rawToBudget(row: RawBudgetRow, spent: number): Budget {
	const amount = Number(row.amount);
	return {
		id: row.id,
		name: row.name,
		holderId: row.holder_id,
		accountCode: row.account_code,
		category: row.category,
		period: row.period as BudgetPeriod,
		amount,
		spent,
		remaining: Math.max(0, amount - spent),
		periodStart: toIso(row.period_start),
		periodEnd: toIso(row.period_end),
		enabled: row.enabled,
		createdAt: toIso(row.created_at),
	};
}

// =============================================================================
// CORE OPERATIONS
// =============================================================================

export async function createBudget(
	ctx: SummaContext,
	params: {
		name: string;
		holderId?: string;
		accountCode?: string;
		category?: string;
		period: BudgetPeriod;
		amount: number;
		periodStart: string;
		periodEnd: string;
	},
): Promise<Budget> {
	const t = createTableResolver(ctx.options.schema);
	const d = ctx.dialect;
	const ledgerId = getLedgerId(ctx);

	const rows = await ctx.adapter.raw<RawBudgetRow>(
		`INSERT INTO ${t("budget")}
		 (id, name, ledger_id, holder_id, account_code, category, period, amount,
		  period_start, period_end)
		 VALUES (${d.generateUuid()}, $1, $2, $3, $4, $5, $6, $7, $8, $9)
		 RETURNING *`,
		[
			params.name,
			ledgerId,
			params.holderId ?? null,
			params.accountCode ?? null,
			params.category ?? null,
			params.period,
			params.amount,
			params.periodStart,
			params.periodEnd,
		],
	);

	const row = rows[0];
	if (!row) throw SummaError.internal("Failed to create budget");
	return rawToBudget(row, 0);
}

export async function listBudgets(
	ctx: SummaContext,
	params?: {
		holderId?: string;
		category?: string;
		activeOnly?: boolean;
	},
): Promise<Budget[]> {
	const t = createTableResolver(ctx.options.schema);
	const ledgerId = getLedgerId(ctx);
	const conditions: string[] = ["ledger_id = $1"];
	const queryParams: unknown[] = [ledgerId];
	let idx = 2;

	if (params?.holderId) {
		conditions.push(`holder_id = $${idx++}`);
		queryParams.push(params.holderId);
	}
	if (params?.category) {
		conditions.push(`category = $${idx++}`);
		queryParams.push(params.category);
	}
	if (params?.activeOnly) {
		conditions.push("enabled = true");
		conditions.push("period_end >= NOW()");
	}

	const rows = await ctx.adapter.raw<RawBudgetRow>(
		`SELECT * FROM ${t("budget")}
		 WHERE ${conditions.join(" AND ")}
		 ORDER BY created_at DESC`,
		queryParams,
	);

	const results: Budget[] = [];
	for (const row of rows) {
		const spent = await getSpentInPeriod(ctx, row);
		results.push(rawToBudget(row, spent));
	}
	return results;
}

export async function getBudget(ctx: SummaContext, budgetId: string): Promise<Budget> {
	const t = createTableResolver(ctx.options.schema);
	const rows = await ctx.adapter.raw<RawBudgetRow>(`SELECT * FROM ${t("budget")} WHERE id = $1`, [
		budgetId,
	]);
	if (!rows[0]) throw SummaError.notFound("Budget not found");
	const spent = await getSpentInPeriod(ctx, rows[0]);
	return rawToBudget(rows[0], spent);
}

export async function updateBudget(
	ctx: SummaContext,
	budgetId: string,
	params: { amount?: number; enabled?: boolean },
): Promise<Budget> {
	const t = createTableResolver(ctx.options.schema);
	const sets: string[] = [];
	const queryParams: unknown[] = [];
	let idx = 1;

	if (params.amount !== undefined) {
		sets.push(`amount = $${idx++}`);
		queryParams.push(params.amount);
	}
	if (params.enabled !== undefined) {
		sets.push(`enabled = $${idx++}`);
		queryParams.push(params.enabled);
	}

	if (sets.length === 0) throw SummaError.invalidArgument("No fields to update");

	queryParams.push(budgetId);

	const rows = await ctx.adapter.raw<RawBudgetRow>(
		`UPDATE ${t("budget")} SET ${sets.join(", ")} WHERE id = $${idx} RETURNING *`,
		queryParams,
	);
	if (!rows[0]) throw SummaError.notFound("Budget not found");
	const spent = await getSpentInPeriod(ctx, rows[0]);
	return rawToBudget(rows[0], spent);
}

export async function deleteBudget(ctx: SummaContext, budgetId: string): Promise<void> {
	const t = createTableResolver(ctx.options.schema);
	// Delete snapshots first (FK constraint)
	await ctx.adapter.rawMutate(`DELETE FROM ${t("budget_snapshot")} WHERE budget_id = $1`, [
		budgetId,
	]);
	const affected = await ctx.adapter.rawMutate(`DELETE FROM ${t("budget")} WHERE id = $1`, [
		budgetId,
	]);
	if (affected === 0) throw SummaError.notFound("Budget not found");
}

// =============================================================================
// PLUGIN FACTORY
// =============================================================================

export function budgeting(options?: BudgetingOptions): SummaPlugin {
	const mode = options?.enforcementMode ?? "hard";

	return {
		id: "budgeting",

		$Infer: {} as { Budget: Budget; BudgetSnapshot: BudgetSnapshot },

		schema: budgetingSchema,

		hooks: {
			beforeTransaction: async (params) => {
				if (params.type !== "debit" && params.type !== "transfer") return;

				const ctx = params.ctx;
				const t = createTableResolver(ctx.options.schema);
				const ledgerId = getLedgerId(ctx);
				const holderId = params.holderId ?? params.sourceHolderId;
				if (!holderId) return;

				// Find active budgets matching this holder/category
				const conditions: string[] = [
					"ledger_id = $1",
					"enabled = true",
					"period_start <= NOW()",
					"period_end >= NOW()",
				];
				const queryParams: unknown[] = [ledgerId];
				let idx = 2;

				// Match budgets that apply to this holder or are global
				conditions.push(`(holder_id = $${idx++} OR holder_id IS NULL)`);
				queryParams.push(holderId);

				// Match budgets for this category or without category filter
				conditions.push(`(category = $${idx++} OR category IS NULL)`);
				queryParams.push(params.category ?? null);

				const budgets = await ctx.adapter.raw<RawBudgetRow>(
					`SELECT * FROM ${t("budget")}
					 WHERE ${conditions.join(" AND ")}`,
					queryParams,
				);

				for (const budget of budgets) {
					const spent = await getSpentInPeriod(ctx, budget);
					const budgetAmount = Number(budget.amount);

					if (spent + params.amount > budgetAmount) {
						if (mode === "hard") {
							throw SummaError.limitExceeded(
								`Budget "${budget.name}" exceeded: spent ${spent} + ${params.amount} > limit ${budgetAmount}`,
							);
						}
						ctx.logger.warn("Budget soft limit exceeded", {
							budgetId: budget.id,
							budgetName: budget.name,
							spent,
							amount: params.amount,
							limit: budgetAmount,
						});
					}
				}
			},
		},

		workers: [
			{
				id: "budget-snapshot",
				description: "Snapshot budget utilization for trend analysis",
				interval: options?.snapshotInterval ?? "1d",
				leaseRequired: true,
				handler: async (ctx: SummaContext) => {
					const t = createTableResolver(ctx.options.schema);
					const d = ctx.dialect;
					const ledgerId = getLedgerId(ctx);

					const budgets = await ctx.adapter.raw<RawBudgetRow>(
						`SELECT * FROM ${t("budget")}
						 WHERE ledger_id = $1 AND enabled = true
						   AND period_start <= NOW() AND period_end >= NOW()`,
						[ledgerId],
					);

					for (const budget of budgets) {
						const spent = await getSpentInPeriod(ctx, budget);
						await ctx.adapter.rawMutate(
							`INSERT INTO ${t("budget_snapshot")} (id, budget_id, spent)
							 VALUES (${d.generateUuid()}, $1, $2)`,
							[budget.id, spent],
						);
					}

					if (budgets.length > 0) {
						ctx.logger.info("Budget snapshots recorded", {
							count: budgets.length,
						});
					}
				},
			},
		],

		endpoints: [
			{
				method: "POST",
				path: "/budgets",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const body = req.body as Parameters<typeof createBudget>[1];
					if (!body.name || !body.period || !body.amount || !body.periodStart || !body.periodEnd) {
						return jsonRes(400, {
							error: {
								code: "INVALID_ARGUMENT",
								message: "name, period, amount, periodStart, periodEnd required",
							},
						});
					}
					const budget = await createBudget(ctx, body);
					return jsonRes(201, budget);
				},
			},
			{
				method: "GET",
				path: "/budgets",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const budgets = await listBudgets(ctx, {
						holderId: req.query.holderId,
						category: req.query.category,
						activeOnly: req.query.activeOnly === "true",
					});
					return jsonRes(200, budgets);
				},
			},
			{
				method: "GET",
				path: "/budgets/:id",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const budget = await getBudget(ctx, req.params.id ?? "");
					return jsonRes(200, budget);
				},
			},
			{
				method: "PATCH",
				path: "/budgets/:id",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const body = req.body as {
						amount?: number;
						enabled?: boolean;
					};
					const budget = await updateBudget(ctx, req.params.id ?? "", body);
					return jsonRes(200, budget);
				},
			},
			{
				method: "DELETE",
				path: "/budgets/:id",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					await deleteBudget(ctx, req.params.id ?? "");
					return jsonRes(200, { success: true });
				},
			},
		],
	};
}
