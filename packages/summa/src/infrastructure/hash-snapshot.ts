// =============================================================================
// HASH SNAPSHOT — O(recent entries) verification via snapshots
// =============================================================================
// Stores the latest verified hash per account, enabling verifyFromSnapshot()
// to skip re-verifying the entire chain. Reduces daily reconciliation from
// O(all entries) to O(entries since last snapshot).

import type { SummaContext } from "@summa-ledger/core";
import { createTableResolver } from "@summa-ledger/core/db";
import { verifyHashChainFrom } from "./hash-chain.js";

// =============================================================================
// TYPES
// =============================================================================

export interface HashSnapshot {
	ledgerId: string;
	accountId: string;
	snapshotVersion: number;
	snapshotHash: string;
	entryCount: number;
	createdAt: Date;
}

// =============================================================================
// CREATE SNAPSHOT
// =============================================================================

/**
 * Create (or update) a hash snapshot for a specific account.
 * Reads the latest entry's account_version + hash and stores it.
 * Only updates if the new version is higher than the existing snapshot.
 */
export async function createHashSnapshot(
	ctx: SummaContext,
	accountId: string,
	ledgerId: string,
): Promise<HashSnapshot | null> {
	const t = createTableResolver(ctx.options.schema);
	const d = ctx.dialect;

	// Get the latest entry for this account
	const rows = await ctx.adapter.raw<{
		account_version: number;
		hash: string;
	}>(
		`SELECT account_version, hash
		 FROM ${t("entry")}
		 WHERE ledger_id = $1 AND account_id = $2
		 ORDER BY account_version DESC
		 LIMIT 1`,
		[ledgerId, accountId],
	);

	const latest = rows[0];
	if (!latest) return null;

	// Count total entries for this account
	const countRows = await ctx.adapter.raw<{ cnt: number }>(
		`SELECT COUNT(*)::int AS cnt
		 FROM ${t("entry")}
		 WHERE ledger_id = $1 AND account_id = $2`,
		[ledgerId, accountId],
	);
	const entryCount = countRows[0]?.cnt ?? 0;

	// Upsert snapshot — only update if new version is higher
	await ctx.adapter.rawMutate(
		`INSERT INTO ${t("hash_snapshot")} (id, ledger_id, account_id, snapshot_version, snapshot_hash, entry_count, created_at)
		 VALUES (${d.generateUuid()}, $1, $2, $3, $4, $5, ${d.now()})
		 ON CONFLICT (ledger_id, account_id)
		 DO UPDATE SET
			snapshot_version = EXCLUDED.snapshot_version,
			snapshot_hash = EXCLUDED.snapshot_hash,
			entry_count = EXCLUDED.entry_count,
			created_at = EXCLUDED.created_at
		 WHERE ${t("hash_snapshot")}.snapshot_version < EXCLUDED.snapshot_version`,
		[ledgerId, accountId, latest.account_version, latest.hash, entryCount],
	);

	return {
		ledgerId,
		accountId,
		snapshotVersion: Number(latest.account_version),
		snapshotHash: latest.hash,
		entryCount,
		createdAt: new Date(),
	};
}

// =============================================================================
// VERIFY FROM SNAPSHOT
// =============================================================================

/**
 * Verify the hash chain for an account, starting from the latest snapshot.
 * Falls back to full verification if no snapshot exists.
 *
 * Returns verification result including whether a snapshot was used and
 * how many entries were skipped.
 */
export async function verifyFromSnapshot(
	ctx: SummaContext,
	accountId: string,
	ledgerId: string,
): Promise<{
	valid: boolean;
	brokenAtVersion?: number;
	entryCount: number;
	usedSnapshot: boolean;
	skippedViaSnapshot: number;
}> {
	const t = createTableResolver(ctx.options.schema);

	// Try to find existing snapshot
	const snapshotRows = await ctx.adapter.raw<{
		snapshot_version: number;
		snapshot_hash: string;
		entry_count: number;
	}>(
		`SELECT snapshot_version, snapshot_hash, entry_count
		 FROM ${t("hash_snapshot")}
		 WHERE ledger_id = $1 AND account_id = $2
		 LIMIT 1`,
		[ledgerId, accountId],
	);

	const snapshot = snapshotRows[0];

	if (!snapshot) {
		// No snapshot — full verification
		const result = await verifyHashChainFrom(ctx, "account", accountId, ledgerId, -1, null);
		return {
			valid: result.valid,
			brokenAtVersion: result.brokenAtVersion,
			entryCount: result.eventCount,
			usedSnapshot: false,
			skippedViaSnapshot: 0,
		};
	}

	// Verify only entries after the snapshot
	const result = await verifyHashChainFrom(
		ctx,
		"account",
		accountId,
		ledgerId,
		snapshot.snapshot_version,
		snapshot.snapshot_hash,
	);

	return {
		valid: result.valid,
		brokenAtVersion: result.brokenAtVersion,
		entryCount: snapshot.entry_count + result.eventCount,
		usedSnapshot: true,
		skippedViaSnapshot: snapshot.entry_count,
	};
}

// =============================================================================
// GET SNAPSHOT
// =============================================================================

/**
 * Retrieve the current hash snapshot for an account, if one exists.
 */
export async function getHashSnapshot(
	ctx: SummaContext,
	accountId: string,
	ledgerId: string,
): Promise<HashSnapshot | null> {
	const t = createTableResolver(ctx.options.schema);

	const rows = await ctx.adapter.raw<{
		ledger_id: string;
		account_id: string;
		snapshot_version: number;
		snapshot_hash: string;
		entry_count: number;
		created_at: string | Date;
	}>(
		`SELECT ledger_id, account_id, snapshot_version, snapshot_hash, entry_count, created_at
		 FROM ${t("hash_snapshot")}
		 WHERE ledger_id = $1 AND account_id = $2
		 LIMIT 1`,
		[ledgerId, accountId],
	);

	const row = rows[0];
	if (!row) return null;

	return {
		ledgerId: row.ledger_id,
		accountId: row.account_id,
		snapshotVersion: Number(row.snapshot_version),
		snapshotHash: row.snapshot_hash,
		entryCount: Number(row.entry_count),
		createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
	};
}
