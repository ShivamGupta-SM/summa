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
} from "@summa-ledger/core";
import { createTableResolver } from "@summa-ledger/core/db";
import * as accounts from "../managers/account-manager.js";
import * as holds from "../managers/hold-manager.js";
import * as transactions from "../managers/transaction-manager.js";

// =============================================================================
// TYPES
// =============================================================================

export interface AdminOptions {
	/** Base path prefix for admin routes (default: "/admin") */
	basePath?: string;
	/** Authorization check. Called on every admin request. Return `true` to allow, `false` to reject with 403. */
	authorize?: (req: PluginApiRequest) => boolean | Promise<boolean>;
}

// =============================================================================
// HELPERS
// =============================================================================

function json(status: number, body: unknown): PluginApiResponse {
	return { status, body };
}

const VALID_TX_STATUSES = new Set([
	"pending",
	"inflight",
	"posted",
	"expired",
	"voided",
	"reversed",
]);
const VALID_TX_TYPES = new Set(["credit", "debit", "transfer"]);
const VALID_HOLD_STATUSES = new Set(["inflight", "posted", "voided", "expired"]);
const VALID_ACCOUNT_STATUSES = new Set(["active", "frozen", "closed"]);

/** Clamp pagination params to safe integer ranges */
function parsePagination(query: Record<string, string | undefined>): {
	page: number;
	perPage: number;
	offset: number;
} {
	const page = Math.max(1, Math.floor(Number(query.page) || 1));
	const perPage = Math.min(Math.max(1, Math.floor(Number(query.perPage) || 50)), 200);
	const offset = (page - 1) * perPage;
	return { page, perPage, offset };
}

// =============================================================================
// PLUGIN FACTORY
// =============================================================================

export function admin(options?: AdminOptions): SummaPlugin {
	const prefix = options?.basePath ?? "/admin";
	const authorize = options?.authorize;

	if (!authorize) {
	}

	// Wrap each endpoint handler with authorization check
	function withAuth(handler: PluginEndpoint["handler"]): PluginEndpoint["handler"] {
		if (!authorize) return handler;
		return async (req, ctx) => {
			const allowed = await authorize(req);
			if (!allowed) {
				return json(403, { error: { code: "FORBIDDEN", message: "Admin access denied" } });
			}
			return handler(req, ctx);
		};
	}

	const endpoints: PluginEndpoint[] = [
		// --- Account Management ---
		{
			method: "GET",
			path: `${prefix}/accounts`,
			handler: async (req, ctx) => {
				if (req.query.status && !VALID_ACCOUNT_STATUSES.has(req.query.status)) {
					return json(400, {
						error: {
							code: "VALIDATION_ERROR",
							message: `Invalid account status: "${req.query.status}"`,
						},
					});
				}
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
					...body,
					holderId: req.params.holderId ?? "",
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
					...body,
					holderId: req.params.holderId ?? "",
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
					...body,
					holderId: req.params.holderId ?? "",
				});
				return json(200, result);
			},
		},

		// --- Transaction Management ---
		{
			method: "GET",
			path: `${prefix}/transactions`,
			handler: async (req: PluginApiRequest, ctx: SummaContext) => {
				const tbl = createTableResolver(ctx.options.schema);
				const { perPage, offset } = parsePagination(req.query);

				const conditions: string[] = [];
				const params: unknown[] = [];
				let paramIdx = 1;

				if (req.query.status) {
					if (!VALID_TX_STATUSES.has(req.query.status)) {
						return json(400, {
							error: {
								code: "VALIDATION_ERROR",
								message: `Invalid transaction status: "${req.query.status}"`,
							},
						});
					}
					conditions.push(`t.status = $${paramIdx++}`);
					params.push(req.query.status);
				}
				if (req.query.type) {
					if (!VALID_TX_TYPES.has(req.query.type)) {
						return json(400, {
							error: {
								code: "VALIDATION_ERROR",
								message: `Invalid transaction type: "${req.query.type}"`,
							},
						});
					}
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
					`SELECT COUNT(*) as cnt FROM ${tbl("transfer")} t ${whereClause}`,
					params,
				);
				const total = Number(countRows[0]?.cnt ?? 0);

				const dataParams = [...params, perPage, offset];
				const rows = await ctx.adapter.raw<Record<string, unknown>>(
					`SELECT * FROM ${tbl("transfer")} t ${whereClause} ORDER BY t.created_at DESC LIMIT $${paramIdx++} OFFSET $${paramIdx}`,
					dataParams,
				);

				return json(200, { transactions: rows, total, hasMore: offset + perPage < total });
			},
		},
		{
			method: "GET",
			path: `${prefix}/transactions/:id`,
			handler: async (req, ctx) => {
				const tbl = createTableResolver(ctx.options.schema);
				const txn = await transactions.getTransaction(ctx, req.params.id ?? "");
				const entries = await ctx.adapter.raw<Record<string, unknown>>(
					`SELECT * FROM ${tbl("entry")} WHERE transfer_id = $1 ORDER BY created_at ASC`,
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
					...body,
					transactionId: req.params.id ?? "",
				});
				return json(200, result);
			},
		},

		// --- Hold Management ---
		{
			method: "GET",
			path: `${prefix}/holds`,
			handler: async (req: PluginApiRequest, ctx: SummaContext) => {
				const tbl = createTableResolver(ctx.options.schema);
				const { perPage, offset } = parsePagination(req.query);

				const conditions: string[] = [];
				const params: unknown[] = [];
				let paramIdx = 1;

				if (req.query.status) {
					if (!VALID_HOLD_STATUSES.has(req.query.status)) {
						return json(400, {
							error: {
								code: "VALIDATION_ERROR",
								message: `Invalid hold status: "${req.query.status}"`,
							},
						});
					}
					conditions.push(`status = $${paramIdx++}`);
					params.push(req.query.status);
				}

				const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

				const countRows = await ctx.adapter.raw<{ cnt: string }>(
					`SELECT COUNT(*) as cnt FROM ${tbl("hold")} ${whereClause}`,
					params,
				);
				const total = Number(countRows[0]?.cnt ?? 0);

				const dataParams = [...params, perPage, offset];
				const rows = await ctx.adapter.raw<Record<string, unknown>>(
					`SELECT * FROM ${tbl("hold")} ${whereClause} ORDER BY created_at DESC LIMIT $${paramIdx++} OFFSET $${paramIdx}`,
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
				const tbl = createTableResolver(ctx.options.schema);
				const rows = await ctx.adapter.raw<Record<string, unknown>>(
					`SELECT id, identifier, name, currency, balance, available_balance, status, created_at
					 FROM ${tbl("account")}
					 WHERE is_system = true
					 ORDER BY identifier ASC`,
					[],
				);
				return json(200, { systemAccounts: rows });
			},
		},

		// --- Impersonation ---
		{
			method: "POST",
			path: `${prefix}/impersonate/:holderId`,
			handler: async (req, ctx) => {
				const holderId = req.params.holderId ?? "";
				// Verify the account exists
				const account = await accounts.getAccountByHolder(ctx, holderId);
				const balance = await accounts.getAccountBalance(ctx, account);
				const txns = await transactions.listAccountTransactions(ctx, {
					holderId,
					perPage: 20,
				});
				const activeHolds = await holds.listActiveHolds(ctx, {
					holderId,
					perPage: 10,
				});

				return json(200, {
					impersonating: holderId,
					account,
					balance,
					recentTransactions: txns.transactions,
					activeHolds: activeHolds.holds,
				});
			},
		},

		// --- Dashboard Stats ---
		{
			method: "GET",
			path: `${prefix}/stats`,
			handler: async (_req, ctx) => {
				const tbl = createTableResolver(ctx.options.schema);
				const [accountStats, txnStats, holdStats] = await Promise.all([
					ctx.adapter.raw<Record<string, string>>(
						`SELECT
							COUNT(*) AS total,
							COUNT(*) FILTER (WHERE status = 'active') AS active,
							COUNT(*) FILTER (WHERE status = 'frozen') AS frozen,
							COUNT(*) FILTER (WHERE status = 'closed') AS closed
						 FROM ${tbl("account")}`,
						[],
					),
					ctx.adapter.raw<Record<string, string>>(
						`SELECT
							COUNT(*) AS total,
							COALESCE(SUM(amount), 0) AS total_volume,
							COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE) AS today_count,
							COALESCE(SUM(amount) FILTER (WHERE created_at >= CURRENT_DATE), 0) AS today_volume
						 FROM ${tbl("transfer")}
						 WHERE status = 'posted'`,
						[],
					),
					ctx.adapter.raw<Record<string, string>>(
						`SELECT
							COUNT(*) AS total_active,
							COALESCE(SUM(amount), 0) AS total_amount
						 FROM ${tbl("hold")}
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
		endpoints: endpoints.map((ep) => ({ ...ep, handler: withAuth(ep.handler) })),
	};
}
