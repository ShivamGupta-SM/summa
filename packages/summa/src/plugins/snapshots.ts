// =============================================================================
// SNAPSHOTS PLUGIN -- Daily balance snapshot generation
// =============================================================================
// Creates immutable end-of-day balance snapshots for every account that had
// activity since the last snapshot run. Snapshots are point-in-time records
// used for historical balance queries, month-end reporting, and reconciliation.
//
// Design:
//   - Batched processing (500 accounts at a time) via keyset pagination
//   - Snapshots are immutable (INSERT ... ON CONFLICT DO NOTHING)
//   - Only accounts with new entries since last snapshot are processed
//   - Block checkpoint hash is recorded for audit trail
//
// All SQL uses ctx.adapter.raw() with $1, $2 parameterized queries.

import type { SummaContext, SummaPlugin } from "@summa/core";

// =============================================================================
// TYPES
// =============================================================================

interface SnapshotResult {
	accountsSnapshotted: number;
	skippedUnchanged: number;
	date: string;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const BATCH_SIZE = 500;

// =============================================================================
// PLUGIN FACTORY
// =============================================================================

export function snapshots(): SummaPlugin {
	return {
		id: "snapshots",

		workers: [
			{
				id: "daily-snapshots",
				description: "Create daily balance snapshots for all accounts with recent activity",
				handler: async (ctx: SummaContext) => {
					await triggerDailySnapshot(ctx);
				},
				interval: "1d",
				leaseRequired: true,
			},
		],
	};
}

// =============================================================================
// TRIGGER DAILY SNAPSHOT
// =============================================================================

async function triggerDailySnapshot(ctx: SummaContext): Promise<SnapshotResult> {
	const today = new Date();
	const snapshotDate = toDateString(today);

	ctx.logger.info("Daily snapshot starting", { date: snapshotDate });

	// ---- Get latest block checkpoint hash for audit trail ----
	const blockRows = await ctx.adapter.raw<{
		block_hash: string;
	}>(
		`SELECT block_hash
		 FROM block_checkpoint
		 ORDER BY block_sequence DESC
		 LIMIT 1`,
		[],
	);

	const checkpointHash = blockRows[0]?.block_hash ?? null;

	// ---- Find last snapshot date to determine which accounts changed ----
	const lastSnapshotRows = await ctx.adapter.raw<{
		max_date: string | null;
	}>(
		`SELECT MAX(snapshot_date)::text AS max_date
		 FROM account_snapshot`,
		[],
	);

	const lastSnapshotDate = lastSnapshotRows[0]?.max_date ?? null;

	// ---- Determine changed account IDs since last snapshot ----
	// If no previous snapshot exists, we snapshot all accounts.
	// Otherwise, find accounts with entries created after the last snapshot date.
	let changedAccountIds: Set<string> | null = null;

	if (lastSnapshotDate) {
		// Find accounts that had entry_record activity since last snapshot
		const changedRows = await ctx.adapter.raw<{
			account_id: string;
		}>(
			`SELECT DISTINCT e.account_id
			 FROM entry_record e
			 WHERE e.account_id IS NOT NULL
			   AND e.created_at > ($1::date + interval '1 day')::timestamptz
			 LIMIT 100000`,
			[lastSnapshotDate],
		);

		changedAccountIds = new Set(changedRows.map((r) => r.account_id));

		ctx.logger.info("Changed accounts since last snapshot", {
			lastSnapshotDate,
			changedAccountCount: changedAccountIds.size,
		});
	}

	// ---- Batched processing using keyset pagination on account_balance.id ----
	let accountsSnapshotted = 0;
	let skippedUnchanged = 0;
	let lastAccountId = "";

	while (true) {
		const accountBatch = await ctx.adapter.raw<{
			id: string;
			holder_id: string;
			balance: number;
			credit_balance: number;
			debit_balance: number;
			pending_credit: number;
			pending_debit: number;
			currency: string;
			status: string;
		}>(
			`SELECT id, holder_id, balance, credit_balance, debit_balance,
			        pending_credit, pending_debit, currency, status
			 FROM account_balance
			 WHERE id > $1
			 ORDER BY id ASC
			 LIMIT $2`,
			[lastAccountId, BATCH_SIZE],
		);

		if (accountBatch.length === 0) break;

		for (const acct of accountBatch) {
			// Skip accounts that have not changed since last snapshot
			if (changedAccountIds !== null && !changedAccountIds.has(acct.id)) {
				skippedUnchanged++;
				continue;
			}

			const balance = Number(acct.balance);
			const creditBalance = Number(acct.credit_balance);
			const debitBalance = Number(acct.debit_balance);
			const pendingCredit = Number(acct.pending_credit);
			const pendingDebit = Number(acct.pending_debit);
			const availableBalance = Math.max(0, balance - pendingDebit);

			// Insert snapshot with ON CONFLICT DO NOTHING (immutable)
			// Each (account_id, snapshot_date) pair is unique.
			await ctx.adapter.rawMutate(
				`INSERT INTO account_snapshot (
					account_id,
					snapshot_date,
					balance,
					credit_balance,
					debit_balance,
					pending_credit,
					pending_debit,
					available_balance,
					currency,
					account_status,
					checkpoint_hash
				 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
				 ${ctx.dialect.onConflictDoNothing(["account_id", "snapshot_date"])}`,
				[
					acct.id,
					snapshotDate,
					balance,
					creditBalance,
					debitBalance,
					pendingCredit,
					pendingDebit,
					availableBalance,
					acct.currency,
					acct.status,
					checkpointHash,
				],
			);

			accountsSnapshotted++;
		}

		lastAccountId = accountBatch[accountBatch.length - 1]?.id ?? lastAccountId;
		if (accountBatch.length < BATCH_SIZE) break;
	}

	const result: SnapshotResult = {
		accountsSnapshotted,
		skippedUnchanged,
		date: snapshotDate,
	};

	ctx.logger.info("Daily snapshot complete", {
		...result,
		checkpointHash: checkpointHash ?? "none",
	});

	return result;
}

// =============================================================================
// QUERY: HISTORICAL BALANCE
// =============================================================================

/**
 * Get the balance snapshot for a specific account on a specific date.
 * Returns null if no snapshot exists for that date.
 */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getHistoricalBalance(
	ctx: SummaContext,
	accountId: string,
	date: Date | string,
): Promise<{
	accountId: string;
	snapshotDate: string;
	balance: number;
	creditBalance: number;
	debitBalance: number;
	pendingCredit: number;
	pendingDebit: number;
	availableBalance: number;
	currency: string;
	accountStatus: string;
	checkpointHash: string | null;
} | null> {
	// Return null early for invalid UUID to avoid PostgreSQL cast errors
	if (!UUID_REGEX.test(accountId)) return null;

	const dateStr = typeof date === "string" ? date : toDateString(date);

	const rows = await ctx.adapter.raw<{
		account_id: string;
		snapshot_date: string | Date;
		balance: number;
		credit_balance: number;
		debit_balance: number;
		pending_credit: number;
		pending_debit: number;
		available_balance: number;
		currency: string;
		account_status: string;
		checkpoint_hash: string | null;
	}>(
		`SELECT
			account_id,
			snapshot_date,
			balance,
			credit_balance,
			debit_balance,
			pending_credit,
			pending_debit,
			available_balance,
			currency,
			account_status,
			checkpoint_hash
		 FROM account_snapshot
		 WHERE account_id = $1
		   AND snapshot_date = $2
		 LIMIT 1`,
		[accountId, dateStr],
	);

	const row = rows[0];
	if (!row) return null;

	return {
		accountId: row.account_id,
		snapshotDate: String(row.snapshot_date),
		balance: Number(row.balance),
		creditBalance: Number(row.credit_balance),
		debitBalance: Number(row.debit_balance),
		pendingCredit: Number(row.pending_credit),
		pendingDebit: Number(row.pending_debit),
		availableBalance: Number(row.available_balance),
		currency: row.currency,
		accountStatus: row.account_status,
		checkpointHash: row.checkpoint_hash,
	};
}

// =============================================================================
// QUERY: END-OF-MONTH BALANCE
// =============================================================================

/**
 * Get the last snapshot in a given month for an account.
 * Useful for month-end reporting and financial statements.
 * Returns null if no snapshot exists in that month.
 */
export async function getEndOfMonthBalance(
	ctx: SummaContext,
	accountId: string,
	year: number,
	month: number,
): Promise<{
	accountId: string;
	snapshotDate: string;
	balance: number;
	creditBalance: number;
	debitBalance: number;
	pendingCredit: number;
	pendingDebit: number;
	availableBalance: number;
	currency: string;
	accountStatus: string;
	checkpointHash: string | null;
} | null> {
	// Return null early for invalid UUID to avoid PostgreSQL cast errors
	if (!UUID_REGEX.test(accountId)) return null;

	// Build the first and last day of the month
	// month is 1-indexed (1=January, 12=December)
	const monthStr = String(month).padStart(2, "0");
	const startDate = `${year}-${monthStr}-01`;

	// Last day of month: go to first of next month, subtract 1 day
	const nextMonth = month === 12 ? 1 : month + 1;
	const nextYear = month === 12 ? year + 1 : year;
	const nextMonthStr = String(nextMonth).padStart(2, "0");
	const endDate = `${nextYear}-${nextMonthStr}-01`;

	const rows = await ctx.adapter.raw<{
		account_id: string;
		snapshot_date: string | Date;
		balance: number;
		credit_balance: number;
		debit_balance: number;
		pending_credit: number;
		pending_debit: number;
		available_balance: number;
		currency: string;
		account_status: string;
		checkpoint_hash: string | null;
	}>(
		`SELECT
			account_id,
			snapshot_date,
			balance,
			credit_balance,
			debit_balance,
			pending_credit,
			pending_debit,
			available_balance,
			currency,
			account_status,
			checkpoint_hash
		 FROM account_snapshot
		 WHERE account_id = $1
		   AND snapshot_date >= $2::date
		   AND snapshot_date < $3::date
		 ORDER BY snapshot_date DESC
		 LIMIT 1`,
		[accountId, startDate, endDate],
	);

	const row = rows[0];
	if (!row) return null;

	return {
		accountId: row.account_id,
		snapshotDate: String(row.snapshot_date),
		balance: Number(row.balance),
		creditBalance: Number(row.credit_balance),
		debitBalance: Number(row.debit_balance),
		pendingCredit: Number(row.pending_credit),
		pendingDebit: Number(row.pending_debit),
		availableBalance: Number(row.available_balance),
		currency: row.currency,
		accountStatus: row.account_status,
		checkpointHash: row.checkpoint_hash,
	};
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Convert a Date to a YYYY-MM-DD string (UTC).
 */
function toDateString(date: Date): string {
	const y = date.getUTCFullYear();
	const m = String(date.getUTCMonth() + 1).padStart(2, "0");
	const d = String(date.getUTCDate()).padStart(2, "0");
	return `${y}-${m}-${d}`;
}
