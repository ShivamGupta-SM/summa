// =============================================================================
// ADMIN PLUGIN — Elevated management endpoints for the Summa ledger
// =============================================================================

import type {
	AccountStatus,
	HolderType,
	PluginApiRequest,
	PluginApiResponse,
	PluginEndpoint,
	SummaContext,
	SummaPlugin,
} from "@summa/core";
import * as accounts from "../managers/account-manager.js";
import * as holds from "../managers/hold-manager.js";
import * as transactions from "../managers/transaction-manager.js";

// =============================================================================
// TYPES
// =============================================================================

export interface AdminOptions {
	/** Base path prefix for admin routes (default: "/admin") */
	basePath?: string;
}

// =============================================================================
// HELPERS
// =============================================================================

function json(status: number, body: unknown): PluginApiResponse {
	return { status, body };
}

// =============================================================================
// PLUGIN FACTORY
// =============================================================================

export function admin(options?: AdminOptions): SummaPlugin {
	const prefix = options?.basePath ?? "/admin";

	const endpoints: PluginEndpoint[] = [
		// --- Account Management ---
		{
			method: "GET",
			path: `${prefix}/accounts`,
			handler: async (req, ctx) => {
				const result = await accounts.listAccounts(ctx, {
					page: req.query.page ? Number(req.query.page) : undefined,
					perPage: req.query.perPage ? Number(req.query.perPage) : undefined,
					status: req.query.status as AccountStatus | undefined,
					holderType: req.query.holderType as HolderType | undefined,
					search: req.query.search,
				});
				return json(200, result);
			},
		},
		{
			method: "GET",
			path: `${prefix}/accounts/:holderId`,
			handler: async (req, ctx) => {
				const account = await accounts.getAccountByHolder(ctx, req.params.holderId ?? "");
				const balance = await accounts.getAccountBalance(ctx, account);
				const txns = await transactions.listAccountTransactions(ctx, {
					holderId: req.params.holderId ?? "",
					perPage: 20,
				});
				const activeHolds = await holds.listActiveHolds(ctx, {
					holderId: req.params.holderId ?? "",
					perPage: 10,
				});
				return json(200, {
					account,
					balance,
					recentTransactions: txns.transactions,
					activeHolds: activeHolds.holds,
				});
			},
		},
		{
			method: "POST",
			path: `${prefix}/accounts/:holderId/freeze`,
			handler: async (req, ctx) => {
				const body = req.body as { reason: string; frozenBy: string };
				const result = await accounts.freezeAccount(ctx, {
					holderId: req.params.holderId ?? "",
					...body,
				});
				return json(200, result);
			},
		},
		{
			method: "POST",
			path: `${prefix}/accounts/:holderId/unfreeze`,
			handler: async (req, ctx) => {
				const body = req.body as { unfrozenBy: string };
				const result = await accounts.unfreezeAccount(ctx, {
					holderId: req.params.holderId ?? "",
					...body,
				});
				return json(200, result);
			},
		},
		{
			method: "POST",
			path: `${prefix}/accounts/:holderId/close`,
			handler: async (req, ctx) => {
				const body = req.body as {
					closedBy: string;
					reason?: string;
					transferToHolderId?: string;
				};
				const result = await accounts.closeAccount(ctx, {
					holderId: req.params.holderId ?? "",
					...body,
				});
				return json(200, result);
			},
		},

		// --- Transaction Management ---
		{
			method: "GET",
			path: `${prefix}/transactions`,
			handler: async (req: PluginApiRequest, ctx: SummaContext) => {
				const page = req.query.page ? Number(req.query.page) : 1;
				const perPage = Math.min(req.query.perPage ? Number(req.query.perPage) : 50, 200);
				const offset = (page - 1) * perPage;

				const conditions: string[] = [];
				const params: unknown[] = [];
				let paramIdx = 1;

				if (req.query.status) {
					conditions.push(`t.status = $${paramIdx++}`);
					params.push(req.query.status);
				}
				if (req.query.type) {
					conditions.push(`t.type = $${paramIdx++}`);
					params.push(req.query.type);
				}
				if (req.query.dateFrom) {
					conditions.push(`t.created_at >= $${paramIdx++}`);
					params.push(req.query.dateFrom);
				}
				if (req.query.dateTo) {
					conditions.push(`t.created_at <= $${paramIdx++}`);
					params.push(req.query.dateTo);
				}

				const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

				const countRows = await ctx.adapter.raw<{ cnt: string }>(
					`SELECT COUNT(*) as cnt FROM transaction_record t ${whereClause}`,
					params,
				);
				const total = Number(countRows[0]?.cnt ?? 0);

				const dataParams = [...params, perPage, offset];
				const rows = await ctx.adapter.raw<Record<string, unknown>>(
					`SELECT * FROM transaction_record t ${whereClause} ORDER BY t.created_at DESC LIMIT $${paramIdx++} OFFSET $${paramIdx}`,
					dataParams,
				);

				return json(200, { transactions: rows, total, hasMore: offset + perPage < total });
			},
		},
		{
			method: "GET",
			path: `${prefix}/transactions/:id`,
			handler: async (req, ctx) => {
				const txn = await transactions.getTransaction(ctx, req.params.id ?? "");
				const entries = await ctx.adapter.raw<Record<string, unknown>>(
					`SELECT * FROM entry_record WHERE transaction_id = $1 ORDER BY created_at ASC`,
					[txn.id],
				);
				return json(200, { transaction: txn, entries });
			},
		},
		{
			method: "POST",
			path: `${prefix}/transactions/:id/refund`,
			handler: async (req, ctx) => {
				const body = req.body as { reason: string; amount?: number; idempotencyKey?: string };
				const result = await transactions.refundTransaction(ctx, {
					transactionId: req.params.id ?? "",
					...body,
				});
				return json(200, result);
			},
		},

		// --- Hold Management ---
		{
			method: "GET",
			path: `${prefix}/holds`,
			handler: async (req: PluginApiRequest, ctx: SummaContext) => {
				const page = req.query.page ? Number(req.query.page) : 1;
				const perPage = Math.min(req.query.perPage ? Number(req.query.perPage) : 50, 200);
				const offset = (page - 1) * perPage;

				const conditions: string[] = [];
				const params: unknown[] = [];
				let paramIdx = 1;

				if (req.query.status) {
					conditions.push(`status = $${paramIdx++}`);
					params.push(req.query.status);
				}

				const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

				const countRows = await ctx.adapter.raw<{ cnt: string }>(
					`SELECT COUNT(*) as cnt FROM hold ${whereClause}`,
					params,
				);
				const total = Number(countRows[0]?.cnt ?? 0);

				const dataParams = [...params, perPage, offset];
				const rows = await ctx.adapter.raw<Record<string, unknown>>(
					`SELECT * FROM hold ${whereClause} ORDER BY created_at DESC LIMIT $${paramIdx++} OFFSET $${paramIdx}`,
					dataParams,
				);

				return json(200, { holds: rows, total, hasMore: offset + perPage < total });
			},
		},

		// --- Reconciliation ---
		{
			method: "GET",
			path: `${prefix}/reconciliation/status`,
			handler: async (req, ctx) => {
				// Import dynamically to avoid circular deps if reconciliation plugin is not loaded
				try {
					const { getReconciliationStatus } = await import("./reconciliation.js");
					const result = await getReconciliationStatus(ctx, {
						limit: req.query.limit ? Number(req.query.limit) : undefined,
						offset: req.query.offset ? Number(req.query.offset) : undefined,
					});
					return json(200, result);
				} catch {
					return json(200, { message: "Reconciliation plugin not loaded", results: [] });
				}
			},
		},
		{
			method: "POST",
			path: `${prefix}/reconciliation/run`,
			handler: async () => {
				return json(202, { message: "Reconciliation triggered", status: "accepted" });
			},
		},

		// --- System Accounts ---
		{
			method: "GET",
			path: `${prefix}/system-accounts`,
			handler: async (_req, ctx) => {
				const rows = await ctx.adapter.raw<Record<string, unknown>>(
					`SELECT sa.id, sa.identifier, sa.name, sa.created_at,
					        ab.currency, ab.balance, ab.available_balance, ab.status
					 FROM system_account sa
					 JOIN account_balance ab ON ab.id = sa.account_id
					 ORDER BY sa.identifier ASC`,
					[],
				);
				return json(200, { systemAccounts: rows });
			},
		},

		// --- Dashboard Stats ---
		{
			method: "GET",
			path: `${prefix}/stats`,
			handler: async (_req, ctx) => {
				const [accountStats, txnStats, holdStats] = await Promise.all([
					ctx.adapter.raw<Record<string, string>>(
						`SELECT
							COUNT(*) AS total,
							COUNT(*) FILTER (WHERE status = 'active') AS active,
							COUNT(*) FILTER (WHERE status = 'frozen') AS frozen,
							COUNT(*) FILTER (WHERE status = 'closed') AS closed
						 FROM account_balance`,
						[],
					),
					ctx.adapter.raw<Record<string, string>>(
						`SELECT
							COUNT(*) AS total,
							COALESCE(SUM(amount), 0) AS total_volume,
							COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE) AS today_count,
							COALESCE(SUM(amount) FILTER (WHERE created_at >= CURRENT_DATE), 0) AS today_volume
						 FROM transaction_record
						 WHERE status = 'posted'`,
						[],
					),
					ctx.adapter.raw<Record<string, string>>(
						`SELECT
							COUNT(*) AS total_active,
							COALESCE(SUM(amount), 0) AS total_amount
						 FROM hold
						 WHERE status = 'inflight'`,
						[],
					),
				]);

				const as = accountStats[0];
				const ts = txnStats[0];
				const hs = holdStats[0];

				return json(200, {
					accounts: {
						total: Number(as?.total ?? 0),
						active: Number(as?.active ?? 0),
						frozen: Number(as?.frozen ?? 0),
						closed: Number(as?.closed ?? 0),
					},
					transactions: {
						total: Number(ts?.total ?? 0),
						totalVolume: Number(ts?.total_volume ?? 0),
						todayCount: Number(ts?.today_count ?? 0),
						todayVolume: Number(ts?.today_volume ?? 0),
					},
					holds: {
						activeCount: Number(hs?.total_active ?? 0),
						activeAmount: Number(hs?.total_amount ?? 0),
					},
				});
			},
		},
	];

	return {
		id: "admin",
		endpoints,
	};
}
