// =============================================================================
// LIMIT MANAGER -- Transaction velocity controls and limit enforcement
// =============================================================================
// Enforces per-transaction, daily, and monthly limits for compliance.
// Limits are stored in account_limit table; aggregates from entry table.
//
// v2 changes:
// - Velocity queries use `entry` table instead of `account_transaction_log`
// - logTransaction/logTransactionInTx removed (no separate velocity log needed)
// - entry_type maps to txnType: CREDIT → credit, DEBIT → debit

import type {
	AccountLimitInfo,
	LimitType,
	SummaContext,
	SummaTransactionAdapter,
} from "@summa-ledger/core";
import { SummaError } from "@summa-ledger/core";
import { createTableResolver } from "@summa-ledger/core/db";
import { getAccountByHolder } from "./account-manager.js";
import type { RawLimitRow } from "./raw-types.js";

// =============================================================================
// TYPES
// =============================================================================

export type { AccountLimitInfo, LimitType } from "@summa-ledger/core";

export interface LimitCheckResult {
	allowed: boolean;
	limitType?: LimitType;
	maxAmount?: number;
	currentUsage?: number;
	remainingAmount?: number;
	message?: string;
}

// =============================================================================
// CHECK LIMITS (call before transactions)
// =============================================================================

export async function checkLimits(
	ctx: SummaContext,
	params: {
		holderId: string;
		amount: number;
		txnType: "credit" | "debit" | "hold";
		category?: string;
	},
): Promise<LimitCheckResult> {
	const VALID_TXN_TYPES: ReadonlySet<string> = new Set(["credit", "debit", "hold"]);
	if (!VALID_TXN_TYPES.has(params.txnType)) {
		throw SummaError.invalidArgument(
			`Invalid txnType: "${params.txnType}". Must be one of: credit, debit, hold`,
		);
	}

	const { holderId, amount, txnType, category } = params;
	const t = createTableResolver(ctx.options.schema);

	const account = await getAccountByHolder(ctx, holderId);

	// Fetch all applicable limits for this account
	const limits = await ctx.adapter.raw<RawLimitRow>(
		`SELECT * FROM ${t("account_limit")}
     WHERE account_id = $1 AND enabled = true`,
		[account.id],
	);

	if (limits.length === 0) {
		return { allowed: true };
	}

	const now = new Date();
	const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
	const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

	// Check per-transaction limits first (no DB query needed)
	for (const limit of limits) {
		if (limit.category && limit.category !== category) continue;
		if (limit.limit_type === "per_transaction" && amount > limit.max_amount) {
			return {
				allowed: false,
				limitType: "per_transaction" as LimitType,
				maxAmount: limit.max_amount,
				currentUsage: amount,
				remainingAmount: 0,
				message: `Transaction amount ${amount} exceeds per-transaction limit of ${limit.max_amount}`,
			};
		}
	}

	// Check if we need daily/monthly usage at all
	const needsDaily = limits.some(
		(l) => l.limit_type === "daily" && (!l.category || l.category === category),
	);
	const needsMonthly = limits.some(
		(l) => l.limit_type === "monthly" && (!l.category || l.category === category),
	);

	if (needsDaily || needsMonthly) {
		const { daily, monthly } = await getUsageBoth(
			ctx.adapter,
			account.id,
			startOfDay,
			startOfMonth,
			txnType,
			category,
			t,
		);

		for (const limit of limits) {
			if (limit.category && limit.category !== category) continue;

			if (limit.limit_type === "daily") {
				if (daily + amount > limit.max_amount) {
					return {
						allowed: false,
						limitType: "daily" as LimitType,
						maxAmount: limit.max_amount,
						currentUsage: daily,
						remainingAmount: Math.max(0, limit.max_amount - daily),
						message: `Daily limit exceeded. Used: ${daily}, Limit: ${limit.max_amount}`,
					};
				}
			}

			if (limit.limit_type === "monthly") {
				if (monthly + amount > limit.max_amount) {
					return {
						allowed: false,
						limitType: "monthly" as LimitType,
						maxAmount: limit.max_amount,
						currentUsage: monthly,
						remainingAmount: Math.max(0, limit.max_amount - monthly),
						message: `Monthly limit exceeded. Used: ${monthly}, Limit: ${limit.max_amount}`,
					};
				}
			}
		}
	}

	return { allowed: true };
}

// =============================================================================
// ENFORCE LIMITS (throws if limit exceeded)
// =============================================================================

export async function enforceLimits(
	ctx: SummaContext,
	params: {
		holderId: string;
		amount: number;
		txnType: "credit" | "debit" | "hold";
		category?: string;
	},
): Promise<void> {
	const result = await checkLimits(ctx, params);
	if (!result.allowed) {
		ctx.logger.warn("Transaction limit exceeded", {
			holderId: params.holderId,
			amount: params.amount,
			limitType: result.limitType,
			maxAmount: result.maxAmount,
			currentUsage: result.currentUsage,
		});
		throw SummaError.limitExceeded(result.message || "Transaction limit exceeded");
	}
}

/**
 * Enforce limits using an already-known account ID (from a FOR UPDATE row).
 * Avoids the redundant getAccountByHolder() lookup.
 */
const noLimitsCache = new Map<string, number>();
const NO_LIMITS_CACHE_TTL_MS = 60_000;

/** Clear the no-limits cache (useful for testing or after limit changes). */
export function clearNoLimitsCache(): void {
	noLimitsCache.clear();
}

export async function enforceLimitsWithAccountId(
	tx: SummaTransactionAdapter,
	params: {
		accountId: string;
		holderId: string;
		amount: number;
		txnType: "credit" | "debit" | "hold";
		category?: string;
	},
): Promise<void> {
	const VALID_TXN_TYPES: ReadonlySet<string> = new Set(["credit", "debit", "hold"]);
	if (!VALID_TXN_TYPES.has(params.txnType)) {
		throw SummaError.invalidArgument(
			`Invalid txnType: "${params.txnType}". Must be one of: credit, debit, hold`,
		);
	}

	const { accountId, amount, txnType, category } = params;

	// Fast path: skip DB query if we recently confirmed this account has no limits
	const cachedAt = noLimitsCache.get(accountId);
	if (cachedAt && Date.now() - cachedAt < NO_LIMITS_CACHE_TTL_MS) {
		return;
	}

	const t = createTableResolver(tx.options?.schema ?? "summa");

	const limits = await tx.raw<RawLimitRow>(
		`SELECT * FROM ${t("account_limit")}
     WHERE account_id = $1 AND enabled = true`,
		[accountId],
	);

	if (limits.length === 0) {
		noLimitsCache.set(accountId, Date.now());
		return;
	}

	noLimitsCache.delete(accountId);

	const now = new Date();
	const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
	const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

	for (const limit of limits) {
		if (limit.category && limit.category !== category) continue;
		if (limit.limit_type === "per_transaction" && amount > limit.max_amount) {
			throw SummaError.limitExceeded(
				`Transaction amount ${amount} exceeds per-transaction limit of ${limit.max_amount}`,
			);
		}
	}

	const needsDaily = limits.some(
		(l) => l.limit_type === "daily" && (!l.category || l.category === category),
	);
	const needsMonthly = limits.some(
		(l) => l.limit_type === "monthly" && (!l.category || l.category === category),
	);

	if (needsDaily || needsMonthly) {
		const { daily, monthly } = await getUsageBoth(
			tx,
			accountId,
			startOfDay,
			startOfMonth,
			txnType,
			category,
			t,
		);

		for (const limit of limits) {
			if (limit.category && limit.category !== category) continue;
			if (limit.limit_type === "daily" && daily + amount > limit.max_amount) {
				throw SummaError.limitExceeded(
					`Daily limit exceeded. Used: ${daily}, Limit: ${limit.max_amount}`,
				);
			}
			if (limit.limit_type === "monthly" && monthly + amount > limit.max_amount) {
				throw SummaError.limitExceeded(
					`Monthly limit exceeded. Used: ${monthly}, Limit: ${limit.max_amount}`,
				);
			}
		}
	}
}

// =============================================================================
// SET LIMIT
// =============================================================================

export async function setLimit(
	ctx: SummaContext,
	params: {
		holderId: string;
		limitType: LimitType;
		maxAmount: number;
		category?: string;
		enabled?: boolean;
	},
): Promise<AccountLimitInfo> {
	const { holderId, limitType, maxAmount, category = null, enabled = true } = params;

	const VALID_LIMIT_TYPES: ReadonlySet<string> = new Set(["per_transaction", "daily", "monthly"]);
	if (!VALID_LIMIT_TYPES.has(limitType)) {
		throw SummaError.invalidArgument(
			`Invalid limitType: "${limitType}". Must be one of: per_transaction, daily, monthly`,
		);
	}

	if (maxAmount <= 0) {
		throw SummaError.invalidArgument("maxAmount must be positive");
	}

	const t = createTableResolver(ctx.options.schema);
	const account = await getAccountByHolder(ctx, holderId);

	const existingRows =
		category === null
			? await ctx.adapter.raw<RawLimitRow>(
					`SELECT * FROM ${t("account_limit")}
       WHERE account_id = $1 AND limit_type = $2 AND category IS NULL
       LIMIT 1`,
					[account.id, limitType],
				)
			: await ctx.adapter.raw<RawLimitRow>(
					`SELECT * FROM ${t("account_limit")}
       WHERE account_id = $1 AND limit_type = $2 AND category = $3
       LIMIT 1`,
					[account.id, limitType, category],
				);

	let rows: RawLimitRow[];
	if (existingRows[0]) {
		rows = await ctx.adapter.raw<RawLimitRow>(
			`UPDATE ${t("account_limit")}
       SET max_amount = $1, enabled = $2, updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
			[maxAmount, enabled, existingRows[0].id],
		);
	} else {
		rows = await ctx.adapter.raw<RawLimitRow>(
			`INSERT INTO ${t("account_limit")} (account_id, limit_type, max_amount, category, enabled)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
			[account.id, limitType, maxAmount, category, enabled],
		);
	}

	return rawRowToLimit(rows[0]!);
}

// =============================================================================
// GET LIMITS
// =============================================================================

export async function getLimits(
	ctx: SummaContext,
	params: { holderId: string },
): Promise<AccountLimitInfo[]> {
	const t = createTableResolver(ctx.options.schema);
	const account = await getAccountByHolder(ctx, params.holderId);

	const rows = await ctx.readAdapter.raw<RawLimitRow>(
		`SELECT * FROM ${t("account_limit")} WHERE account_id = $1`,
		[account.id],
	);

	return rows.map(rawRowToLimit);
}

// =============================================================================
// REMOVE LIMIT
// =============================================================================

export async function removeLimit(
	ctx: SummaContext,
	params: {
		holderId: string;
		limitType: LimitType;
		category?: string;
	},
): Promise<void> {
	const t = createTableResolver(ctx.options.schema);
	const account = await getAccountByHolder(ctx, params.holderId);

	const categoryCondition = params.category ? `AND category = $3` : `AND category IS NULL`;

	const queryParams: unknown[] = [account.id, params.limitType];
	if (params.category) queryParams.push(params.category);

	await ctx.adapter.rawMutate(
		`DELETE FROM ${t("account_limit")}
     WHERE account_id = $1
       AND limit_type = $2
       ${categoryCondition}`,
		queryParams,
	);
}

// =============================================================================
// GET USAGE SUMMARY
// =============================================================================

export async function getUsageSummary(
	ctx: SummaContext,
	params: {
		holderId: string;
		txnType?: "credit" | "debit" | "hold";
		category?: string;
	},
): Promise<{ daily: number; monthly: number }> {
	const t = createTableResolver(ctx.options.schema);
	const account = await getAccountByHolder(ctx, params.holderId);

	const now = new Date();
	const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
	const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

	return getUsageBoth(
		ctx.adapter,
		account.id,
		startOfDay,
		startOfMonth,
		params.txnType,
		params.category,
		t,
	);
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Single query for both daily and monthly usage via conditional aggregation.
 * In v2, queries the `entry` table directly instead of `account_transaction_log`.
 * Maps txnType to entry_type: "credit" → "CREDIT", "debit" → "DEBIT".
 */
async function getUsageBoth(
	queryRunner: Pick<SummaTransactionAdapter, "raw">,
	accountId: string,
	startOfDay: Date,
	startOfMonth: Date,
	txnType?: "credit" | "debit" | "hold",
	_category?: string,
	t?: ReturnType<typeof createTableResolver>,
): Promise<{ daily: number; monthly: number }> {
	if (!t) t = createTableResolver("summa");

	// Map txnType to entry_type for querying the entry table
	const conditions: string[] = ["account_id = $1", "created_at >= $2"];
	const params: unknown[] = [accountId, startOfMonth.toISOString()];
	let paramIdx = 3;

	if (txnType && txnType !== "hold") {
		// Map: "credit" → "CREDIT", "debit" → "DEBIT"
		conditions.push(`entry_type = $${paramIdx++}`);
		params.push(txnType.toUpperCase());
	}

	// Add startOfDay as last param for the CASE expression
	params.push(startOfDay.toISOString());
	const startOfDayParam = paramIdx;

	const rows = await queryRunner.raw<{ daily: number; monthly: number }>(
		`SELECT
       COALESCE(SUM(CASE WHEN created_at >= $${startOfDayParam} THEN amount ELSE 0 END)::bigint, 0) as daily,
       COALESCE(SUM(amount)::bigint, 0) as monthly
     FROM ${t("entry")}
     WHERE ${conditions.join(" AND ")}`,
		params,
	);

	const result = rows[0];
	return {
		daily: Number(result?.daily ?? 0),
		monthly: Number(result?.monthly ?? 0),
	};
}

function rawRowToLimit(row: RawLimitRow): AccountLimitInfo {
	return {
		id: row.id,
		accountId: row.account_id,
		limitType: row.limit_type as LimitType,
		maxAmount: Number(row.max_amount),
		category: row.category,
		enabled: row.enabled,
		createdAt: new Date(row.created_at),
		updatedAt: new Date(row.updated_at),
	};
}
