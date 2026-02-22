// =============================================================================
// VERIFICATION SNAPSHOTS PLUGIN — Automated hash snapshot creation
// =============================================================================
// Creates periodic hash snapshots for active aggregates, enabling O(recent)
// verification instead of O(all events). Workers run on a configurable
// interval and use distributed leasing to avoid duplicate work.
//
// NOTE: These are *cryptographic verification* snapshots (hash chain optimization),
// NOT balance snapshots. For point-in-time balance snapshots, see the `snapshots` plugin.

import type { SummaContext, SummaPlugin, TableDefinition } from "@summa/core";
import { createTableResolver } from "@summa/core/db";
import { createHashSnapshot } from "../infrastructure/hash-snapshot.js";

// =============================================================================
// TYPES
// =============================================================================

export interface VerificationSnapshotsOptions {
	/** How often the snapshot worker runs. Default: "6h" */
	snapshotInterval?: string;
	/** Max aggregates to snapshot per worker run. Default: 500 */
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
			aggregate_type: { type: "text", notNull: true },
			aggregate_id: { type: "text", notNull: true },
			snapshot_version: { type: "bigint", notNull: true },
			snapshot_hash: { type: "text", notNull: true },
			event_count: { type: "integer", notNull: true },
			created_at: { type: "timestamp", notNull: true, default: "NOW()" },
		},
		indexes: [
			{
				name: "uq_hash_snapshot_aggregate",
				columns: ["ledger_id", "aggregate_type", "aggregate_id"],
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
				description: "Create hash snapshots for aggregates with recent events",
				interval: snapshotInterval,
				leaseRequired: true,
				handler: async (ctx: SummaContext) => {
					const t = createTableResolver(ctx.options.schema);

					// Find aggregates that have events newer than their latest snapshot.
					// LEFT JOIN ensures aggregates with no snapshot are included.
					const staleAggregates = await ctx.adapter.raw<{
						ledger_id: string;
						aggregate_type: string;
						aggregate_id: string;
					}>(
						`SELECT DISTINCT e.ledger_id, e.aggregate_type, e.aggregate_id
						 FROM ${t("ledger_event")} e
						 LEFT JOIN ${t("hash_snapshot")} hs
						   ON hs.ledger_id = e.ledger_id
						  AND hs.aggregate_type = e.aggregate_type
						  AND hs.aggregate_id = e.aggregate_id
						 WHERE hs.id IS NULL
						    OR e.created_at > hs.created_at
						 LIMIT $1`,
						[batchSize],
					);

					if (staleAggregates.length === 0) {
						ctx.logger.debug("Hash snapshot worker: no stale aggregates found");
						return;
					}

					let created = 0;
					for (const agg of staleAggregates) {
						try {
							const snapshot = await createHashSnapshot(
								ctx,
								agg.aggregate_type,
								agg.aggregate_id,
								agg.ledger_id,
							);
							if (snapshot) created++;
						} catch (err) {
							ctx.logger.error("Failed to create hash snapshot", {
								aggregateType: agg.aggregate_type,
								aggregateId: agg.aggregate_id,
								ledgerId: agg.ledger_id,
								error: err instanceof Error ? err.message : String(err),
							});
						}
					}

					if (created > 0) {
						ctx.logger.info("Hash snapshots created", {
							created,
							checked: staleAggregates.length,
						});
					}
				},
			},
		],
	};
}

/** @deprecated Use `verificationSnapshots()` instead. */
export const hashSnapshot = verificationSnapshots;
