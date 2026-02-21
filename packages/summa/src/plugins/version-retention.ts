// =============================================================================
// VERSION RETENTION PLUGIN -- Bounded account_balance_version table
// =============================================================================
// As transaction volume grows, account_balance_version accumulates rows
// indefinitely. This plugin periodically archives old version rows, keeping
// the table bounded for fast LATERAL JOIN / index maintenance.
//
// Strategy per account:
//   1. Keep the latest N versions (retainVersions, default 100)
//   2. Keep versions newer than a configurable age (retainDays, default 90)
//   3. Optionally move old rows to an archive table before deleting
//   4. Process accounts in batches to avoid long-running transactions
//
// Archive table (account_balance_version_archive) has the same schema as
// account_balance_version with an added archived_at timestamp.

import type { SummaContext, SummaPlugin, TableDefinition } from "@summa/core";
import { createTableResolver } from "@summa/core/db";

// =============================================================================
// TYPES
// =============================================================================

export interface VersionRetentionOptions {
	/** Keep the latest N versions per account. Default: 100 */
	retainVersions?: number;
	/** Keep versions newer than N days. Default: 90 */
	retainDays?: number;
	/** Move old versions to archive table before deleting. Default: true */
	archiveTable?: boolean;
	/** Number of accounts to process per worker run. Default: 500 */
	batchSize?: number;
	/** How often the retention worker runs. Default: "1h" */
	interval?: string;
}

// =============================================================================
// ARCHIVE TABLE SCHEMA
// =============================================================================

const ARCHIVE_TABLE: Record<string, TableDefinition> = {
	accountBalanceVersionArchive: {
		columns: {
			id: { type: "uuid", primaryKey: true, notNull: true },
			account_id: { type: "uuid", notNull: true },
			version: { type: "integer", notNull: true },
			balance: { type: "bigint", notNull: true, default: "0" },
			credit_balance: { type: "bigint", notNull: true, default: "0" },
			debit_balance: { type: "bigint", notNull: true, default: "0" },
			pending_credit: { type: "bigint", notNull: true, default: "0" },
			pending_debit: { type: "bigint", notNull: true, default: "0" },
			status: { type: "text", notNull: true },
			checksum: { type: "text" },
			freeze_reason: { type: "text" },
			frozen_at: { type: "timestamp" },
			frozen_by: { type: "text" },
			closed_at: { type: "timestamp" },
			closed_by: { type: "text" },
			closure_reason: { type: "text" },
			change_type: { type: "text", notNull: true },
			caused_by_event_id: { type: "uuid" },
			caused_by_transaction_id: { type: "uuid" },
			created_at: { type: "timestamp", notNull: true },
			archived_at: { type: "timestamp", notNull: true, default: "NOW()" },
		},
		indexes: [
			{ name: "idx_abv_archive_account", columns: ["account_id"] },
			{ name: "idx_abv_archive_created", columns: ["created_at"] },
			{ name: "idx_abv_archive_archived", columns: ["archived_at"] },
		],
	},
};

// =============================================================================
// PLUGIN FACTORY
// =============================================================================

export function versionRetention(options?: VersionRetentionOptions): SummaPlugin {
	const retainVersions = options?.retainVersions ?? 100;
	const retainDays = options?.retainDays ?? 90;
	const useArchive = options?.archiveTable !== false;
	const batchSize = options?.batchSize ?? 500;
	const interval = options?.interval ?? "1h";

	return {
		id: "version-retention",

		// Register archive table if enabled
		schema: useArchive ? ARCHIVE_TABLE : undefined,

		workers: [
			{
				id: "version-retention-worker",
				description: "Archive and prune old account_balance_version rows",
				interval,
				leaseRequired: true,
				handler: async (ctx: SummaContext) => {
					const t = createTableResolver(ctx.options.schema);
					let totalArchived = 0;
					let totalDeleted = 0;

					// Find accounts with version rows exceeding the retention threshold.
					// We identify accounts that have more than retainVersions rows to avoid
					// scanning accounts that don't need pruning.
					const accountRows = await ctx.adapter.raw<{ account_id: string; ver_count: number }>(
						`SELECT account_id, COUNT(*)::int AS ver_count
						 FROM ${t("account_balance_version")}
						 GROUP BY account_id
						 HAVING COUNT(*) > $1
						 ORDER BY COUNT(*) DESC
						 LIMIT $2`,
						[retainVersions, batchSize],
					);

					for (const row of accountRows) {
						try {
							const result = await pruneAccountVersions(ctx, t, {
								accountId: row.account_id,
								retainVersions,
								retainDays,
								useArchive,
							});
							totalArchived += result.archived;
							totalDeleted += result.deleted;
						} catch (err) {
							ctx.logger.error("Version retention: failed to prune account", {
								accountId: row.account_id,
								error: err instanceof Error ? err.message : String(err),
							});
						}
					}

					if (totalArchived > 0 || totalDeleted > 0) {
						ctx.logger.info("Version retention: completed", {
							accountsProcessed: accountRows.length,
							totalArchived,
							totalDeleted,
							retainVersions,
							retainDays,
						});
					}
				},
			},
		],

		endpoints: [
			{
				method: "GET",
				path: "/version-retention/status",
				handler: async (_req, ctx) => {
					const t = createTableResolver(ctx.options.schema);

					const versionStats = await ctx.adapter.raw<{
						total_rows: number;
						total_accounts: number;
						max_versions: number;
						avg_versions: number;
					}>(
						`SELECT
						   COUNT(*)::int AS total_rows,
						   COUNT(DISTINCT account_id)::int AS total_accounts,
						   MAX(ct)::int AS max_versions,
						   AVG(ct)::int AS avg_versions
						 FROM (
						   SELECT account_id, COUNT(*) AS ct
						   FROM ${t("account_balance_version")}
						   GROUP BY account_id
						 ) sub`,
						[],
					);

					let archiveRows = 0;
					if (useArchive) {
						try {
							const archiveStats = await ctx.adapter.raw<{ cnt: number }>(
								`SELECT COUNT(*)::int AS cnt FROM ${t("account_balance_version_archive")}`,
								[],
							);
							archiveRows = archiveStats[0]?.cnt ?? 0;
						} catch {
							// Archive table may not exist yet
						}
					}

					const stats = versionStats[0];
					return {
						status: 200,
						body: {
							config: { retainVersions, retainDays, archiveTable: useArchive, batchSize, interval },
							versionTable: {
								totalRows: stats?.total_rows ?? 0,
								totalAccounts: stats?.total_accounts ?? 0,
								maxVersionsPerAccount: stats?.max_versions ?? 0,
								avgVersionsPerAccount: stats?.avg_versions ?? 0,
							},
							archiveTable: useArchive ? { totalRows: archiveRows } : null,
						},
					};
				},
			},
		],
	};
}

// =============================================================================
// INTERNAL: Prune versions for a single account
// =============================================================================

async function pruneAccountVersions(
	ctx: SummaContext,
	t: (name: string) => string,
	params: {
		accountId: string;
		retainVersions: number;
		retainDays: number;
		useArchive: boolean;
	},
): Promise<{ archived: number; deleted: number }> {
	const { accountId, retainVersions, retainDays, useArchive } = params;

	// Find the version threshold: keep latest N versions AND anything newer than retainDays.
	// The threshold is the MAX of (Nth-latest version, oldest version within retainDays).
	const thresholdRows = await ctx.adapter.raw<{ cutoff_version: number }>(
		`SELECT version AS cutoff_version
		 FROM ${t("account_balance_version")}
		 WHERE account_id = $1
		 ORDER BY version DESC
		 OFFSET $2
		 LIMIT 1`,
		[accountId, retainVersions],
	);

	// If there aren't enough versions to exceed retainVersions, nothing to prune
	if (!thresholdRows[0]) {
		return { archived: 0, deleted: 0 };
	}

	const versionCutoff = thresholdRows[0].cutoff_version;

	// Archive old versions (INSERT INTO archive SELECT ... WHERE eligible)
	let archived = 0;
	if (useArchive) {
		archived = await ctx.adapter.rawMutate(
			`INSERT INTO ${t("account_balance_version_archive")} (
			   id, account_id, version, balance, credit_balance, debit_balance,
			   pending_credit, pending_debit, status, checksum,
			   freeze_reason, frozen_at, frozen_by,
			   closed_at, closed_by, closure_reason,
			   change_type, caused_by_event_id, caused_by_transaction_id,
			   created_at
			 )
			 SELECT
			   id, account_id, version, balance, credit_balance, debit_balance,
			   pending_credit, pending_debit, status, checksum,
			   freeze_reason, frozen_at, frozen_by,
			   closed_at, closed_by, closure_reason,
			   change_type, caused_by_event_id, caused_by_transaction_id,
			   created_at
			 FROM ${t("account_balance_version")}
			 WHERE account_id = $1
			   AND version <= $2
			   AND created_at < NOW() - INTERVAL '${retainDays} days'
			 ON CONFLICT (id) DO NOTHING`,
			[accountId, versionCutoff],
		);
	}

	// Delete the pruned rows from the main table
	const deleted = await ctx.adapter.rawMutate(
		`DELETE FROM ${t("account_balance_version")}
		 WHERE account_id = $1
		   AND version <= $2
		   AND created_at < NOW() - INTERVAL '${retainDays} days'`,
		[accountId, versionCutoff],
	);

	return { archived, deleted };
}
