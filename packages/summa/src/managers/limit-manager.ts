// =============================================================================
// LIMIT MANAGER -- Transaction velocity controls and limit enforcement
// =============================================================================
// Enforces per-transaction, daily, and monthly limits for compliance.
// Limits are stored in account_limit table; aggregates from account_transaction_log.

import type { SummaContext, SummaTransactionAdapter } from "@summa/core";
import { SummaError } from "@summa/core";
import { getAccountByHolder } from "./account-manager.js";
import type { RawLimitRow } from "./raw-types.js";

// =============================================================================
// TYPES
// =============================================================================

export type LimitType = "per_transaction" | "daily" | "monthly";

export interface AccountLimitInfo {
	id: string;
	accountId: string;
	limitType: LimitType;
	maxAmount: number;
	category: string | null;
	enabled: boolean;
	createdAt: Date;
	updatedAt: Date;
}

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
	const { holderId, amount, txnType, category } = params;

	const account = await getAccountByHolder(ctx, holderId);

	// Fetch all applicable limits for this account
	const limits = await ctx.adapter.raw<RawLimitRow>(
		`SELECT * FROM account_limit
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
			ctx,
			account.id,
			startOfDay,
			startOfMonth,
			txnType,
			category,
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
 * Avoids the redundant getAccountByHolder() lookup that checkLimits() does.
 * Call this inside transactions where the account is already locked.
 */
export async function enforceLimitsWithAccountId(
	ctx: SummaContext,
	params: {
		accountId: string;
		holderId: string;
		amount: number;
		txnType: "credit" | "debit" | "hold";
		category?: string;
	},
): Promise<void> {
	const { accountId, amount, txnType, category } = params;

	const limits = await ctx.adapter.raw<RawLimitRow>(
		`SELECT * FROM account_limit
     WHERE account_id = $1 AND enabled = true`,
		[accountId],
	);

	if (limits.length === 0) return;

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
			ctx,
			accountId,
			startOfDay,
			startOfMonth,
			txnType,
			category,
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
// LOG TRANSACTION (call after successful transactions)
// =============================================================================

export async function logTransaction(
	ctx: SummaContext,
	params: {
		accountId: string;
		ledgerTxnId: string;
		txnType: "credit" | "debit" | "hold";
		amount: number;
		category?: string;
		reference?: string;
	},
): Promise<void> {
	try {
		await ctx.adapter.raw(
			`INSERT INTO account_transaction_log (account_id, ledger_txn_id, txn_type, amount, category, reference)
       VALUES ($1, $2, $3, $4, $5, $6)`,
			[
				params.accountId,
				params.ledgerTxnId,
				params.txnType,
				params.amount,
				params.category ?? null,
				params.reference ?? null,
			],
		);
	} catch (error) {
		// Log but don't fail -- velocity tracking is auxiliary
		ctx.logger.warn("Failed to log transaction for velocity tracking", {
			ledgerTxnId: params.ledgerTxnId,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

/**
 * Log transaction inside an existing database transaction for atomicity.
 * Ensures velocity tracking is committed/rolled back with the parent transaction.
 */
export async function logTransactionInTx(
	tx: SummaTransactionAdapter,
	params: {
		accountId: string;
		ledgerTxnId: string;
		txnType: "credit" | "debit" | "hold";
		amount: number;
		category?: string;
		reference?: string;
	},
): Promise<void> {
	await tx.raw(
		`INSERT INTO account_transaction_log (account_id, ledger_txn_id, txn_type, amount, category, reference)
     VALUES ($1, $2, $3, $4, $5, $6)`,
		[
			params.accountId,
			params.ledgerTxnId,
			params.txnType,
			params.amount,
			params.category ?? null,
			params.reference ?? null,
		],
	);
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

	if (maxAmount <= 0) {
		throw SummaError.invalidArgument("maxAmount must be positive");
	}

	const account = await getAccountByHolder(ctx, holderId);

	const rows = await ctx.adapter.raw<RawLimitRow>(
		`INSERT INTO account_limit (account_id, limit_type, max_amount, category, enabled)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (account_id, limit_type, category) DO UPDATE
     SET max_amount = $3,
         enabled = $5,
         updated_at = NOW()
     RETURNING *`,
		[account.id, limitType, maxAmount, category, enabled],
	);

	return rawRowToLimit(rows[0]!);
}

// =============================================================================
// GET LIMITS
// =============================================================================

export async function getLimits(
	ctx: SummaContext,
	params: { holderId: string },
): Promise<AccountLimitInfo[]> {
	const account = await getAccountByHolder(ctx, params.holderId);

	const rows = await ctx.adapter.raw<RawLimitRow>(
		`SELECT * FROM account_limit WHERE account_id = $1`,
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
	const account = await getAccountByHolder(ctx, params.holderId);

	const categoryCondition = params.category ? `AND category = $3` : `AND category IS NULL`;

	const queryParams: unknown[] = [account.id, params.limitType];
	if (params.category) queryParams.push(params.category);

	await ctx.adapter.rawMutate(
		`DELETE FROM account_limit
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
	const account = await getAccountByHolder(ctx, params.holderId);

	const now = new Date();
	const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
	const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

	return getUsageBoth(ctx, account.id, startOfDay, startOfMonth, params.txnType, params.category);
}

// =============================================================================
// CLEANUP -- Remove old transaction log entries beyond retention period
// =============================================================================

/**
 * Delete transaction log entries older than the retention period.
 * Velocity limits only use current day and current month data,
 * so entries older than 90 days are safe to remove.
 *
 * Uses batched deletion to avoid holding a long lock on the table.
 */
export async function cleanupOldTransactionLogs(
	ctx: SummaContext,
	retentionDays = 90,
): Promise<number> {
	const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
	let totalDeleted = 0;
	const BATCH_SIZE = 5000;

	while (true) {
		const count = await ctx.adapter.rawMutate(
			`DELETE FROM account_transaction_log
       WHERE id IN (
         SELECT id FROM account_transaction_log
         WHERE created_at < $1
         LIMIT $2
       )`,
			[cutoff.toISOString(), BATCH_SIZE],
		);

		totalDeleted += count;

		if (count < BATCH_SIZE) break;

		// Brief pause between batches to avoid monopolizing the table
		await new Promise((r) => setTimeout(r, 100));
	}

	if (totalDeleted > 0) {
		ctx.logger.info("Cleaned up old transaction log entries", {
			deleted: totalDeleted,
			retentionDays,
		});
	}

	return totalDeleted;
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Single query for both daily and monthly usage via conditional aggregation.
 * Avoids 2 separate SUM queries when both limits exist.
 */
async function getUsageBoth(
	ctx: SummaContext,
	accountId: string,
	startOfDay: Date,
	startOfMonth: Date,
	txnType?: "credit" | "debit" | "hold",
	category?: string,
): Promise<{ daily: number; monthly: number }> {
	// Build dynamic query
	const conditions: string[] = ["account_id = $1", "created_at >= $2"];
	const params: unknown[] = [accountId, startOfMonth.toISOString()];
	let paramIdx = 3;

	if (txnType) {
		conditions.push(`txn_type = $${paramIdx++}`);
		params.push(txnType);
	}
	if (category) {
		conditions.push(`category = $${paramIdx++}`);
		params.push(category);
	}

	// Add startOfDay as last param for the CASE expression
	params.push(startOfDay.toISOString());
	const startOfDayParam = paramIdx;

	const rows = await ctx.adapter.raw<{ daily: number; monthly: number }>(
		`SELECT
       COALESCE(SUM(CASE WHEN created_at >= $${startOfDayParam} THEN amount ELSE 0 END)::bigint, 0) as daily,
       COALESCE(SUM(amount)::bigint, 0) as monthly
     FROM account_transaction_log
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
