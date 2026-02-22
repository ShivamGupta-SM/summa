// =============================================================================
// HASH SNAPSHOT — O(recent events) verification via snapshots
// =============================================================================
// Stores the latest verified hash per aggregate, enabling verifyFromSnapshot()
// to skip re-verifying the entire chain. Reduces daily reconciliation from
// O(all events) to O(events since last snapshot).

import type { SummaContext } from "@summa-ledger/core";
import { createTableResolver } from "@summa-ledger/core/db";
import { verifyHashChainFrom } from "./hash-chain.js";

// =============================================================================
// TYPES
// =============================================================================

export interface HashSnapshot {
	ledgerId: string;
	aggregateType: string;
	aggregateId: string;
	snapshotVersion: number;
	snapshotHash: string;
	eventCount: number;
	createdAt: Date;
}

// =============================================================================
// CREATE SNAPSHOT
// =============================================================================

/**
 * Create (or update) a hash snapshot for a specific aggregate.
 * Reads the latest event's aggregate_version + hash and stores it.
 * Only updates if the new version is higher than the existing snapshot.
 */
export async function createHashSnapshot(
	ctx: SummaContext,
	aggregateType: string,
	aggregateId: string,
	ledgerId: string,
): Promise<HashSnapshot | null> {
	const t = createTableResolver(ctx.options.schema);
	const d = ctx.dialect;

	// Get the latest event for this aggregate
	const rows = await ctx.adapter.raw<{
		aggregate_version: number;
		hash: string;
	}>(
		`SELECT aggregate_version, hash
		 FROM ${t("ledger_event")}
		 WHERE ledger_id = $1 AND aggregate_type = $2 AND aggregate_id = $3
		 ORDER BY aggregate_version DESC
		 LIMIT 1`,
		[ledgerId, aggregateType, aggregateId],
	);

	const latest = rows[0];
	if (!latest) return null;

	// Count total events for this aggregate
	const countRows = await ctx.adapter.raw<{ cnt: number }>(
		`SELECT COUNT(*)::int AS cnt
		 FROM ${t("ledger_event")}
		 WHERE ledger_id = $1 AND aggregate_type = $2 AND aggregate_id = $3`,
		[ledgerId, aggregateType, aggregateId],
	);
	const eventCount = countRows[0]?.cnt ?? 0;

	// Upsert snapshot — only update if new version is higher
	await ctx.adapter.rawMutate(
		`INSERT INTO ${t("hash_snapshot")} (id, ledger_id, aggregate_type, aggregate_id, snapshot_version, snapshot_hash, event_count, created_at)
		 VALUES (${d.generateUuid()}, $1, $2, $3, $4, $5, $6, ${d.now()})
		 ON CONFLICT (ledger_id, aggregate_type, aggregate_id)
		 DO UPDATE SET
			snapshot_version = EXCLUDED.snapshot_version,
			snapshot_hash = EXCLUDED.snapshot_hash,
			event_count = EXCLUDED.event_count,
			created_at = EXCLUDED.created_at
		 WHERE ${t("hash_snapshot")}.snapshot_version < EXCLUDED.snapshot_version`,
		[ledgerId, aggregateType, aggregateId, latest.aggregate_version, latest.hash, eventCount],
	);

	return {
		ledgerId,
		aggregateType,
		aggregateId,
		snapshotVersion: Number(latest.aggregate_version),
		snapshotHash: latest.hash,
		eventCount,
		createdAt: new Date(),
	};
}

// =============================================================================
// VERIFY FROM SNAPSHOT
// =============================================================================

/**
 * Verify the hash chain for an aggregate, starting from the latest snapshot.
 * Falls back to full verification if no snapshot exists.
 *
 * Returns verification result including whether a snapshot was used and
 * how many events were skipped.
 */
export async function verifyFromSnapshot(
	ctx: SummaContext,
	aggregateType: string,
	aggregateId: string,
	ledgerId: string,
): Promise<{
	valid: boolean;
	brokenAtVersion?: number;
	eventCount: number;
	usedSnapshot: boolean;
	skippedViaSnapshot: number;
}> {
	const t = createTableResolver(ctx.options.schema);

	// Try to find existing snapshot
	const snapshotRows = await ctx.adapter.raw<{
		snapshot_version: number;
		snapshot_hash: string;
		event_count: number;
	}>(
		`SELECT snapshot_version, snapshot_hash, event_count
		 FROM ${t("hash_snapshot")}
		 WHERE ledger_id = $1 AND aggregate_type = $2 AND aggregate_id = $3
		 LIMIT 1`,
		[ledgerId, aggregateType, aggregateId],
	);

	const snapshot = snapshotRows[0];

	if (!snapshot) {
		// No snapshot — full verification
		const result = await verifyHashChainFrom(ctx, aggregateType, aggregateId, ledgerId, -1, null);
		return {
			...result,
			usedSnapshot: false,
			skippedViaSnapshot: 0,
		};
	}

	// Verify only events after the snapshot
	const result = await verifyHashChainFrom(
		ctx,
		aggregateType,
		aggregateId,
		ledgerId,
		snapshot.snapshot_version,
		snapshot.snapshot_hash,
	);

	return {
		valid: result.valid,
		brokenAtVersion: result.brokenAtVersion,
		eventCount: snapshot.event_count + result.eventCount,
		usedSnapshot: true,
		skippedViaSnapshot: snapshot.event_count,
	};
}

// =============================================================================
// GET SNAPSHOT
// =============================================================================

/**
 * Retrieve the current hash snapshot for an aggregate, if one exists.
 */
export async function getHashSnapshot(
	ctx: SummaContext,
	aggregateType: string,
	aggregateId: string,
	ledgerId: string,
): Promise<HashSnapshot | null> {
	const t = createTableResolver(ctx.options.schema);

	const rows = await ctx.adapter.raw<{
		ledger_id: string;
		aggregate_type: string;
		aggregate_id: string;
		snapshot_version: number;
		snapshot_hash: string;
		event_count: number;
		created_at: string | Date;
	}>(
		`SELECT ledger_id, aggregate_type, aggregate_id, snapshot_version, snapshot_hash, event_count, created_at
		 FROM ${t("hash_snapshot")}
		 WHERE ledger_id = $1 AND aggregate_type = $2 AND aggregate_id = $3
		 LIMIT 1`,
		[ledgerId, aggregateType, aggregateId],
	);

	const row = rows[0];
	if (!row) return null;

	return {
		ledgerId: row.ledger_id,
		aggregateType: row.aggregate_type,
		aggregateId: row.aggregate_id,
		snapshotVersion: Number(row.snapshot_version),
		snapshotHash: row.snapshot_hash,
		eventCount: Number(row.event_count),
		createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
	};
}
