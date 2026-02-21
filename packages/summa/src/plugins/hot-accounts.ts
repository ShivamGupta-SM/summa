// =============================================================================
// HOT ACCOUNTS PLUGIN -- Batch processing for high-volume system accounts
// =============================================================================
// System accounts use a hot account pattern where individual entries are queued
// in hot_account_entry and periodically batch-aggregated into the system_account
// balance. This avoids row-level lock contention on high-throughput accounts.

import { type SummaContext, type SummaPlugin, validatePluginOptions } from "@summa/core";
import { createTableResolver } from "@summa/core/db";

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
	const opts = validatePluginOptions<HotAccountsOptions>("hot-accounts", options, {
		batchSize: { type: "number", default: 1000 },
		retentionHours: { type: "number", default: 24 },
	});
	const batchSize = opts.batchSize ?? 1000;
	const retentionHours = opts.retentionHours ?? 24;

	return {
		id: "hot-accounts",

		$Infer: {} as { HotAccountStats: HotAccountStats },

		schema: {
			hotAccountEntry: {
				columns: {
					id: { type: "uuid", primaryKey: true, notNull: true },
					sequence_number: { type: "bigint", notNull: true },
					account_id: {
						type: "uuid",
						notNull: true,
						references: { table: "account_balance", column: "id" },
					},
					amount: { type: "bigint", notNull: true },
					entry_type: { type: "text", notNull: true },
					transaction_id: {
						type: "uuid",
						notNull: true,
						references: { table: "transaction_record", column: "id" },
					},
					status: { type: "text", notNull: true, default: "'pending'" },
					created_at: { type: "timestamp", notNull: true, default: "NOW()" },
					processed_at: { type: "timestamp" },
				},
				indexes: [
					{
						name: "idx_hot_account_pending",
						columns: ["status", "account_id", "sequence_number"],
					},
					{ name: "idx_hot_account_entry_txn", columns: ["transaction_id"] },
				],
			},
			hotAccountFailedSequence: {
				columns: {
					id: { type: "uuid", primaryKey: true, notNull: true },
					account_id: {
						type: "uuid",
						notNull: true,
						references: { table: "account_balance", column: "id" },
					},
					entry_ids: { type: "jsonb", notNull: true },
					error_message: { type: "text" },
					net_delta: { type: "bigint", notNull: true, default: "0" },
					credit_delta: { type: "bigint", notNull: true, default: "0" },
					debit_delta: { type: "bigint", notNull: true, default: "0" },
					created_at: { type: "timestamp", notNull: true, default: "NOW()" },
				},
				indexes: [{ name: "idx_hot_account_failed_account", columns: ["account_id"] }],
			},
		},

		workers: [
			{
				id: "hot-account-processor",
				description: "Batch processes pending hot_account_entry rows into system account balances",
				interval: "30s",
				leaseRequired: true,
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
	// Lock, aggregate, and process pending entries within a single transaction
	// so that FOR UPDATE SKIP LOCKED locks are held through the entire processing.
	const { dialect } = ctx;
	const t = createTableResolver(ctx.options.schema);

	let totalProcessed = 0;

	await ctx.adapter
		.transaction(async (tx) => {
			const groups = await tx.raw<AggregatedGroup>(
				`WITH locked_entries AS (
         SELECT id, account_id, amount
         FROM ${t("hot_account_entry")}
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
				return;
			}

			for (const group of groups) {
				const entryIds: string[] =
					typeof group.entry_ids === "string" ? JSON.parse(group.entry_ids) : group.entry_ids;

				// INSERT new system_account_version row (APPEND-ONLY — replaces UPDATE system_account)
				// Lock the immutable system_account parent, read latest version, insert new version.
				await tx.raw(`SELECT id FROM ${t("system_account")} WHERE id = $1 FOR UPDATE`, [
					group.account_id,
				]);
				const versionRows = await tx.raw<{
					version: number;
					balance: number;
					credit_balance: number;
					debit_balance: number;
				}>(
					`SELECT version, balance, credit_balance, debit_balance
         FROM ${t("system_account_version")}
         WHERE account_id = $1
         ORDER BY version DESC LIMIT 1`,
					[group.account_id],
				);
				const current = versionRows[0];
				const prevVersion = current ? Number(current.version) : 0;
				const prevBalance = current ? Number(current.balance) : 0;
				const prevCredit = current ? Number(current.credit_balance) : 0;
				const prevDebit = current ? Number(current.debit_balance) : 0;

				await tx.raw(
					`INSERT INTO ${t("system_account_version")} (account_id, version, balance, credit_balance, debit_balance, change_type)
         VALUES ($1, $2, $3, $4, $5, $6)`,
					[
						group.account_id,
						prevVersion + 1,
						prevBalance + Number(group.net_delta),
						prevCredit + Number(group.credit_delta),
						prevDebit + Number(group.debit_delta),
						"batch_aggregate",
					],
				);

				// Mark all entries in this group as processed
				await tx.rawMutate(
					`UPDATE ${t("hot_account_entry")}
         SET status = 'processed', processed_at = ${dialect.now()}
         WHERE id = ANY($1::uuid[])`,
					[entryIds],
				);

				totalProcessed += entryIds.length;
			}
		})
		.catch((error) => {
			// On failure, the entire transaction rolls back — all entries remain
			// pending and will be retried on the next cycle.
			const errorMessage = error instanceof Error ? error.message : String(error);
			ctx.logger.error("Hot account batch processing failed", { error: errorMessage });
		});

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
	const t = createTableResolver(ctx.options.schema);
	const deleted = await ctx.adapter.rawMutate(
		`DELETE FROM ${t("hot_account_entry")}
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
	const t = createTableResolver(ctx.options.schema);
	const rows = await ctx.adapter.raw<{
		status: string;
		count: number;
	}>(
		`SELECT status, ${ctx.dialect.countAsInt()} AS count
     FROM ${t("hot_account_entry")}
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
		`SELECT ${ctx.dialect.countAsInt()} AS count FROM ${t("hot_account_failed_sequence")}`,
		[],
	);

	if (failedRows[0]) {
		stats.failedSequences = Number(failedRows[0].count);
	}

	return stats;
}
