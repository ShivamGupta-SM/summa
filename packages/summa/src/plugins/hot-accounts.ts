// =============================================================================
// HOT ACCOUNTS PLUGIN -- Batch processing for high-volume system accounts
// =============================================================================
// In v2, system accounts live in the unified `account` table (is_system=true).
// When insertEntryAndUpdateBalance is called with isHotAccount=true, only the
// entry is inserted into the `entry` table -- the account balance is NOT updated.
//
// This plugin periodically aggregates unaggregated entries for system accounts
// and UPDATEs the account balance in batch. A watermark table tracks the last
// processed entry.id per system account to avoid re-processing.

import { computeBalanceChecksum, type SummaContext, type SummaPlugin, validatePluginOptions } from "@summa-ledger/core";
import { createTableResolver } from "@summa-ledger/core/db";
import { getLedgerId } from "../managers/ledger-helpers.js";

// =============================================================================
// OPTIONS
// =============================================================================

export interface HotAccountsOptions {
	/** Max entries per batch. Default: 1000 */
	batchSize?: number;
}

// =============================================================================
// STATS
// =============================================================================

export interface HotAccountStats {
	/** Number of entries not yet aggregated into account balances */
	pending: number;
	/** Number of entries already aggregated */
	aggregated: number;
	/** Number of failed aggregation sequences */
	failedSequences: number;
}

// =============================================================================
// PLUGIN FACTORY
// =============================================================================

export function hotAccounts(options?: HotAccountsOptions): SummaPlugin {
	const opts = validatePluginOptions<HotAccountsOptions>("hot-accounts", options, {
		batchSize: { type: "number", default: 1000 },
	});
	const batchSize = opts.batchSize ?? 1000;

	return {
		id: "hot-accounts",

		$Infer: {} as { HotAccountStats: HotAccountStats },

		schema: {
			// Tracks the last aggregated entry ID per system account.
			// Entries with id > last_entry_id are considered unaggregated.
			hotAccountWatermark: {
				columns: {
					account_id: {
						type: "uuid",
						primaryKey: true,
						notNull: true,
						references: { table: "account", column: "id" },
					},
					last_entry_id: {
						type: "uuid",
						notNull: true,
						references: { table: "entry", column: "id" },
					},
					last_sequence_number: { type: "bigint", notNull: true },
					entries_aggregated: { type: "bigint", notNull: true, default: "0" },
					updated_at: { type: "timestamp", notNull: true, default: "NOW()" },
				},
			},
			// Error tracking for failed batch aggregations.
			hotAccountFailedSequence: {
				columns: {
					id: { type: "uuid", primaryKey: true, notNull: true },
					account_id: {
						type: "uuid",
						notNull: true,
						references: { table: "account", column: "id" },
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
				description:
					"Batch aggregates unaggregated system account entries and updates account balances",
				interval: "30s",
				leaseRequired: true,
				handler: async (ctx: SummaContext) => {
					const count = await processHotAccountBatch(ctx, batchSize);
					if (count > 0) {
						ctx.logger.info("Hot account batch processed", { count });
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
	entry_count: number;
	max_entry_id: string;
	max_sequence_number: number;
	entry_ids: string[];
}

async function processHotAccountBatch(ctx: SummaContext, batchSize: number): Promise<number> {
	const { dialect } = ctx;
	const t = createTableResolver(ctx.options.schema);
	const ledgerId = getLedgerId(ctx);
	const hmacSecret = ctx.options.advanced.hmacSecret ?? null;

	let totalProcessed = 0;

	await ctx.adapter
		.transaction(async (tx) => {
			// Find system accounts that have entries beyond their watermark.
			// For accounts without a watermark row, all entries are unaggregated.
			// We lock the account rows FOR UPDATE to serialize concurrent aggregators.
			//
			// The query:
			// 1. Selects entries from `entry` that belong to system accounts (via JOIN on account.is_system)
			// 2. Filters to entries with sequence_number > the watermark (or all if no watermark exists)
			// 3. Aggregates credit/debit deltas per account
			// 4. Limits total entries processed to batchSize
			const groups = await tx.raw<AggregatedGroup>(
				`WITH system_entries AS (
           SELECT
             e.id AS entry_id,
             e.account_id,
             e.entry_type,
             e.amount,
             e.sequence_number
           FROM ${t("entry")} e
           INNER JOIN ${t("account")} a ON a.id = e.account_id
           LEFT JOIN ${t("hot_account_watermark")} w ON w.account_id = e.account_id
           WHERE a.ledger_id = $1
             AND a.is_system = true
             AND e.sequence_number > COALESCE(w.last_sequence_number, 0)
           ORDER BY e.sequence_number ASC
           LIMIT $2
         )
         SELECT
           account_id,
           SUM(CASE WHEN entry_type = 'CREDIT' THEN amount ELSE -amount END)::bigint AS net_delta,
           SUM(CASE WHEN entry_type = 'CREDIT' THEN amount ELSE 0 END)::bigint AS credit_delta,
           SUM(CASE WHEN entry_type = 'DEBIT' THEN amount ELSE 0 END)::bigint AS debit_delta,
           COUNT(*)::int AS entry_count,
           MAX(entry_id) AS max_entry_id,
           MAX(sequence_number)::bigint AS max_sequence_number,
           array_agg(entry_id) AS entry_ids
         FROM system_entries
         GROUP BY account_id`,
				[ledgerId, batchSize],
			);

			if (groups.length === 0) {
				return;
			}

			for (const group of groups) {
				const entryIds: string[] =
					typeof group.entry_ids === "string" ? JSON.parse(group.entry_ids) : group.entry_ids;

				// Lock the account row for this system account
				const accountRows = await tx.raw<{
					version: number;
					balance: number;
					credit_balance: number;
					debit_balance: number;
					pending_debit: number;
					pending_credit: number;
				}>(
					`SELECT version, balance, credit_balance, debit_balance, pending_debit, pending_credit
           FROM ${t("account")}
           WHERE id = $1 AND ledger_id = $2
           ${dialect.forUpdate()}`,
					[group.account_id, ledgerId],
				);

				const current = accountRows[0];
				if (!current) {
					ctx.logger.error("System account not found during batch aggregation", {
						accountId: group.account_id,
					});
					continue;
				}

				const prevVersion = Number(current.version);
				const prevBalance = Number(current.balance);
				const prevCredit = Number(current.credit_balance);
				const prevDebit = Number(current.debit_balance);

				const newBalance = prevBalance + Number(group.net_delta);
				const newCreditBalance = prevCredit + Number(group.credit_delta);
				const newDebitBalance = prevDebit + Number(group.debit_delta);
				const newVersion = prevVersion + 1;

				// Compute balance checksum for tamper detection
				const checksum = computeBalanceChecksum(
					{
						balance: newBalance,
						creditBalance: newCreditBalance,
						debitBalance: newDebitBalance,
						pendingDebit: Number(current.pending_debit),
						pendingCredit: Number(current.pending_credit),
						lockVersion: newVersion,
					},
					hmacSecret,
				);

				// UPDATE account balance, version, and checksum
				await tx.rawMutate(
					`UPDATE ${t("account")} SET
             balance = $1,
             credit_balance = $2,
             debit_balance = $3,
             version = $4,
             checksum = $5
           WHERE id = $6 AND version = $7`,
					[
						newBalance,
						newCreditBalance,
						newDebitBalance,
						newVersion,
						checksum,
						group.account_id,
						prevVersion,
					],
				);

				// Upsert watermark: track the highest processed entry
				await tx.rawMutate(
					`INSERT INTO ${t("hot_account_watermark")} (account_id, last_entry_id, last_sequence_number, entries_aggregated, updated_at)
           VALUES ($1, $2, $3, $4, ${dialect.now()})
           ON CONFLICT (account_id) DO UPDATE SET
             last_entry_id = EXCLUDED.last_entry_id,
             last_sequence_number = EXCLUDED.last_sequence_number,
             entries_aggregated = ${t("hot_account_watermark")}.entries_aggregated + EXCLUDED.entries_aggregated,
             updated_at = EXCLUDED.updated_at`,
					[
						group.account_id,
						group.max_entry_id,
						Number(group.max_sequence_number),
						Number(group.entry_count),
					],
				);

				totalProcessed += entryIds.length;
			}
		})
		.catch((error) => {
			// On failure, the entire transaction rolls back -- watermarks remain
			// unchanged and entries will be retried on the next cycle.
			const errorMessage = error instanceof Error ? error.message : String(error);
			ctx.logger.error("Hot account batch processing failed", { error: errorMessage });
		});

	return totalProcessed;
}

// =============================================================================
// GET REALTIME BALANCE (committed + pending)
// =============================================================================

export interface RealtimeBalance {
	committedBalance: number;
	pendingDelta: number;
	realtimeBalance: number;
	pendingEntryCount: number;
	lastAggregatedAt: string | null;
}

/**
 * Get the realtime balance for a system account, including unaggregated entries.
 *
 * In v2 the account balance is on the `account` table. The hot-accounts plugin
 * periodically aggregates entries into that balance. Between aggregation cycles,
 * some entries may exist that haven't been folded in yet. This function returns
 * the committed balance + the pending delta from those unaggregated entries.
 */
export async function getRealtimeBalance(
	ctx: SummaContext,
	systemAccountIdentifier: string,
): Promise<RealtimeBalance> {
	const t = createTableResolver(ctx.options.schema);
	const ledgerId = getLedgerId(ctx);

	// Single query: committed balance from account + pending unaggregated entries sum
	const rows = await ctx.adapter.raw<{
		committed_balance: number | null;
		pending_delta: number | null;
		pending_count: number;
		last_aggregated_at: string | null;
	}>(
		`SELECT
			a.balance AS committed_balance,
			p.pending_delta,
			COALESCE(p.pending_count, 0)::int AS pending_count,
			w.updated_at::text AS last_aggregated_at
		 FROM ${t("account")} a
		 LEFT JOIN ${t("hot_account_watermark")} w ON w.account_id = a.id
		 LEFT JOIN LATERAL (
			 SELECT
				 SUM(CASE WHEN e.entry_type = 'CREDIT' THEN e.amount ELSE -e.amount END)::bigint AS pending_delta,
				 COUNT(*)::int AS pending_count
			 FROM ${t("entry")} e
			 WHERE e.account_id = a.id
			   AND e.sequence_number > COALESCE(w.last_sequence_number, 0)
		 ) p ON true
		 WHERE a.ledger_id = $1 AND a.system_identifier = $2 AND a.is_system = true`,
		[ledgerId, systemAccountIdentifier],
	);

	const row = rows[0];
	if (!row) {
		throw new Error(`System account ${systemAccountIdentifier} not found in ledger ${ledgerId}`);
	}

	const committed = Number(row.committed_balance ?? 0);
	const pending = Number(row.pending_delta ?? 0);

	return {
		committedBalance: committed,
		pendingDelta: pending,
		realtimeBalance: committed + pending,
		pendingEntryCount: Number(row.pending_count),
		lastAggregatedAt: row.last_aggregated_at,
	};
}

// =============================================================================
// GET HOT ACCOUNT STATS
// =============================================================================

export async function getHotAccountStats(ctx: SummaContext): Promise<HotAccountStats> {
	const t = createTableResolver(ctx.options.schema);
	const ledgerId = getLedgerId(ctx);

	// Count unaggregated (pending) entries: entries for system accounts beyond watermark
	const pendingRows = await ctx.adapter.raw<{ count: number }>(
		`SELECT ${ctx.dialect.countAsInt()} AS count
     FROM ${t("entry")} e
     INNER JOIN ${t("account")} a ON a.id = e.account_id
     LEFT JOIN ${t("hot_account_watermark")} w ON w.account_id = e.account_id
     WHERE a.ledger_id = $1
       AND a.is_system = true
       AND e.sequence_number > COALESCE(w.last_sequence_number, 0)`,
		[ledgerId],
	);

	// Count aggregated entries from watermark totals
	const aggregatedRows = await ctx.adapter.raw<{ total: number }>(
		`SELECT COALESCE(SUM(entries_aggregated), 0)::bigint AS total
     FROM ${t("hot_account_watermark")} w
     INNER JOIN ${t("account")} a ON a.id = w.account_id
     WHERE a.ledger_id = $1 AND a.is_system = true`,
		[ledgerId],
	);

	// Count failed sequences
	const failedRows = await ctx.adapter.raw<{ count: number }>(
		`SELECT ${ctx.dialect.countAsInt()} AS count
     FROM ${t("hot_account_failed_sequence")} f
     INNER JOIN ${t("account")} a ON a.id = f.account_id
     WHERE a.ledger_id = $1 AND a.is_system = true`,
		[ledgerId],
	);

	return {
		pending: Number(pendingRows[0]?.count ?? 0),
		aggregated: Number(aggregatedRows[0]?.total ?? 0),
		failedSequences: Number(failedRows[0]?.count ?? 0),
	};
}
