// =============================================================================
// HOT ACCOUNTS PLUGIN -- Batch processing for high-volume system accounts
// =============================================================================
// System accounts use a hot account pattern where individual entries are queued
// in hot_account_entry and periodically batch-aggregated into the system_account
// balance. This avoids row-level lock contention on high-throughput accounts.

import type { SummaContext, SummaPlugin } from "@summa/core";

// =============================================================================
// OPTIONS
// =============================================================================

export interface HotAccountsOptions {
	/** Max entries per batch. Default: 1000 */
	batchSize?: number;
	/** Retention hours for processed entries. Default: 24 */
	retentionHours?: number;
}

// =============================================================================
// STATS
// =============================================================================

export interface HotAccountStats {
	pending: number;
	processed: number;
	failedSequences: number;
}

// =============================================================================
// PLUGIN FACTORY
// =============================================================================

export function hotAccounts(options?: HotAccountsOptions): SummaPlugin {
	const batchSize = options?.batchSize ?? 1000;
	const retentionHours = options?.retentionHours ?? 24;

	return {
		id: "hot-accounts",

		$Infer: {} as { HotAccountStats: HotAccountStats },

		workers: [
			{
				id: "hot-account-processor",
				description: "Batch processes pending hot_account_entry rows into system account balances",
				interval: "30s",
				leaseRequired: false,
				handler: async (ctx: SummaContext) => {
					const count = await processHotAccountBatch(ctx, batchSize);
					if (count > 0) {
						ctx.logger.info("Hot account batch processed", { count });
					}
				},
			},
			{
				id: "hot-account-cleanup",
				description: "Cleans up processed hot account entries older than retention period",
				interval: "6h",
				leaseRequired: true,
				handler: async (ctx: SummaContext) => {
					const deleted = await cleanupProcessedHotEntries(ctx, retentionHours);
					if (deleted > 0) {
						ctx.logger.info("Hot account cleanup completed", { deleted, retentionHours });
					}
				},
			},
		],
	};
}

// =============================================================================
// PROCESS HOT ACCOUNT BATCH
// =============================================================================

interface AggregatedGroup {
	account_id: string;
	net_delta: number;
	credit_delta: number;
	debit_delta: number;
	entry_ids: string[];
}

async function processHotAccountBatch(ctx: SummaContext, batchSize: number): Promise<number> {
	// Use a CTE to lock pending entries and aggregate by account_id in a single query.
	// FOR UPDATE SKIP LOCKED ensures concurrent workers don't process the same entries.
	const { dialect } = ctx;
	const groups = await ctx.adapter.raw<AggregatedGroup>(
		`WITH locked_entries AS (
       SELECT id, account_id, amount
       FROM hot_account_entry
       WHERE status = 'pending'
       ORDER BY created_at ASC
       LIMIT $1
       ${dialect.forUpdateSkipLocked()}
     )
     SELECT
       account_id,
       SUM(amount)::bigint AS net_delta,
       SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END)::bigint AS credit_delta,
       SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END)::bigint AS debit_delta,
       array_agg(id) AS entry_ids
     FROM locked_entries
     GROUP BY account_id`,
		[batchSize],
	);

	if (groups.length === 0) {
		return 0;
	}

	let totalProcessed = 0;

	for (const group of groups) {
		const entryIds: string[] =
			typeof group.entry_ids === "string" ? JSON.parse(group.entry_ids) : group.entry_ids;

		try {
			await ctx.adapter.transaction(async (tx) => {
				// Update system_account balance atomically
				await tx.rawMutate(
					`UPDATE system_account
           SET balance = balance + $1,
               credit_balance = credit_balance + $2,
               debit_balance = debit_balance + $3
           WHERE id = $4`,
					[
						Number(group.net_delta),
						Number(group.credit_delta),
						Number(group.debit_delta),
						group.account_id,
					],
				);

				// Mark all entries in this group as processed
				await tx.rawMutate(
					`UPDATE hot_account_entry
           SET status = 'processed', processed_at = ${dialect.now()}
           WHERE id = ANY($1::uuid[])`,
					[entryIds],
				);
			});

			totalProcessed += entryIds.length;
		} catch (error) {
			// On failure, record a failed sequence for traceable recovery
			const errorMessage = error instanceof Error ? error.message : String(error);

			try {
				await ctx.adapter.raw(
					`INSERT INTO hot_account_failed_sequence (account_id, entry_ids, error_message, net_delta, credit_delta, debit_delta)
           VALUES ($1, $2, $3, $4, $5, $6)`,
					[
						group.account_id,
						JSON.stringify(entryIds),
						errorMessage,
						Number(group.net_delta),
						Number(group.credit_delta),
						Number(group.debit_delta),
					],
				);
			} catch (insertError) {
				// Log but don't throw -- the original entries remain pending and
				// will be retried on the next cycle.
				ctx.logger.info("Failed to record hot account failed sequence", {
					accountId: group.account_id,
					error: insertError instanceof Error ? insertError.message : String(insertError),
				});
			}

			ctx.logger.info("Hot account batch failed for account", {
				accountId: group.account_id,
				entryCount: entryIds.length,
				error: errorMessage,
			});
		}
	}

	return totalProcessed;
}

// =============================================================================
// CLEANUP PROCESSED HOT ENTRIES
// =============================================================================

async function cleanupProcessedHotEntries(
	ctx: SummaContext,
	retentionHours: number,
): Promise<number> {
	const { dialect } = ctx;
	const deleted = await ctx.adapter.rawMutate(
		`DELETE FROM hot_account_entry
     WHERE processed_at IS NOT NULL
       AND processed_at < ${dialect.now()} - ${dialect.interval("1 hour")} * $1`,
		[retentionHours],
	);

	return deleted;
}

// =============================================================================
// GET HOT ACCOUNT STATS
// =============================================================================

export async function getHotAccountStats(ctx: SummaContext): Promise<HotAccountStats> {
	const rows = await ctx.adapter.raw<{
		status: string;
		count: number;
	}>(
		`SELECT status, ${ctx.dialect.countAsInt()} AS count
     FROM hot_account_entry
     GROUP BY status`,
		[],
	);

	const stats: HotAccountStats = { pending: 0, processed: 0, failedSequences: 0 };

	for (const row of rows) {
		if (row.status === "pending") stats.pending = Number(row.count);
		else if (row.status === "processed") stats.processed = Number(row.count);
	}

	// Count failed sequences separately from the dedicated table
	const failedRows = await ctx.adapter.raw<{ count: number }>(
		`SELECT ${ctx.dialect.countAsInt()} AS count FROM hot_account_failed_sequence`,
		[],
	);

	if (failedRows[0]) {
		stats.failedSequences = Number(failedRows[0].count);
	}

	return stats;
}
