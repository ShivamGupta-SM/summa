// =============================================================================
// VERIFICATION SNAPSHOTS PLUGIN — Automated hash snapshot creation
// =============================================================================
// Creates periodic hash snapshots for active accounts, enabling O(recent)
// verification instead of O(all entries). Workers run on a configurable
// interval and use distributed leasing to avoid duplicate work.
//
// NOTE: These are *cryptographic verification* snapshots (hash chain optimization),
// NOT balance snapshots. For point-in-time balance snapshots, see the `snapshots` plugin.

import type { SummaContext, SummaPlugin, TableDefinition } from "@summa-ledger/core";
import { createTableResolver } from "@summa-ledger/core/db";
import { createHashSnapshot } from "../infrastructure/hash-snapshot.js";

// =============================================================================
// TYPES
// =============================================================================

export interface VerificationSnapshotsOptions {
	/** How often the snapshot worker runs. Default: "6h" */
	snapshotInterval?: string;
	/** Max accounts to snapshot per worker run. Default: 500 */
	batchSize?: number;
}

/** @deprecated Use `VerificationSnapshotsOptions` instead. */
export type HashSnapshotOptions = VerificationSnapshotsOptions;

// =============================================================================
// SCHEMA
// =============================================================================

const hashSnapshotSchema: Record<string, TableDefinition> = {
	hash_snapshot: {
		columns: {
			id: { type: "uuid", primaryKey: true, notNull: true },
			ledger_id: { type: "text", notNull: true },
			account_id: { type: "text", notNull: true },
			snapshot_version: { type: "bigint", notNull: true },
			snapshot_hash: { type: "text", notNull: true },
			event_count: { type: "integer", notNull: true },
			created_at: { type: "timestamp", notNull: true, default: "NOW()" },
		},
		indexes: [
			{
				name: "uq_hash_snapshot_account",
				columns: ["ledger_id", "account_id"],
				unique: true,
			},
			{
				name: "idx_hash_snapshot_created_at",
				columns: ["created_at"],
			},
		],
	},
};

// =============================================================================
// PLUGIN FACTORY
// =============================================================================

export function verificationSnapshots(options?: VerificationSnapshotsOptions): SummaPlugin {
	const snapshotInterval = options?.snapshotInterval ?? "6h";
	const batchSize = options?.batchSize ?? 500;

	return {
		id: "hash-snapshot",

		schema: hashSnapshotSchema,

		workers: [
			{
				id: "hash-snapshot-creator",
				description: "Create hash snapshots for accounts with recent entries",
				interval: snapshotInterval,
				leaseRequired: true,
				handler: async (ctx: SummaContext) => {
					const t = createTableResolver(ctx.options.schema);

					// Find accounts that have entries newer than their latest snapshot.
					// Hash chains are per-account; entries ARE events in v2.
					// LEFT JOIN ensures accounts with no snapshot are included.
					const staleAccounts = await ctx.adapter.raw<{
						account_id: string;
						ledger_id: string;
					}>(
						`SELECT DISTINCT e.account_id, a.ledger_id
						 FROM ${t("entry")} e
						 JOIN ${t("account")} a ON a.id = e.account_id
						 LEFT JOIN ${t("hash_snapshot")} hs
						   ON hs.account_id = e.account_id
						  AND hs.ledger_id = a.ledger_id
						 WHERE hs.id IS NULL
						    OR e.created_at > hs.created_at
						 LIMIT $1`,
						[batchSize],
					);

					if (staleAccounts.length === 0) {
						ctx.logger.debug("Hash snapshot worker: no stale accounts found");
						return;
					}

					let created = 0;
					for (const agg of staleAccounts) {
						try {
							const snapshot = await createHashSnapshot(
								ctx,
								agg.account_id,
								agg.ledger_id,
							);
							if (snapshot) created++;
						} catch (err) {
							ctx.logger.error("Failed to create hash snapshot", {
								accountId: agg.account_id,
								ledgerId: agg.ledger_id,
								error: err instanceof Error ? err.message : String(err),
							});
						}
					}

					if (created > 0) {
						ctx.logger.info("Hash snapshots created", {
							created,
							checked: staleAccounts.length,
						});
					}
				},
			},
		],
	};
}

/** @deprecated Use `verificationSnapshots()` instead. */
export const hashSnapshot = verificationSnapshots;
