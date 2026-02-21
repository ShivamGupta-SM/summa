// =============================================================================
// HASH CHAIN -- Cryptographic tamper detection
// =============================================================================
// Each event's hash = SHA-256(prevHash + eventData).
// Provides per-aggregate tamper detection + block-based chain checkpoints.
//
// Design: Azure SQL Ledger pattern -- blocks of events chained via prevBlockHash.
// O(new events) per checkpoint, not O(all aggregates). Scales forever.

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { SummaContext } from "@summa/core";
import {
	buildMerkleTree,
	computeHash,
	generateMerkleProof,
	type MerkleProof,
	verifyMerkleProof,
} from "@summa/core";
import { createTableResolver } from "@summa/core/db";

/** Constant-time string comparison to prevent timing attacks on hash verification. */
function safeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// =============================================================================
// CHAIN VERIFICATION
// =============================================================================

/**
 * Verify the hash chain for a specific aggregate.
 * Processes in batches of 500 to avoid loading all events into memory.
 * Carries prevHash across batches for chain continuity.
 */
const VERIFY_BATCH_SIZE = 500;

export async function verifyHashChain(
	ctx: SummaContext,
	aggregateType: string,
	aggregateId: string,
): Promise<{ valid: boolean; brokenAtVersion?: number; eventCount: number }> {
	const t = createTableResolver(ctx.options.schema);
	let computedPrevHash: string | null = null;
	let totalCount = 0;
	let lastVersion = -1;

	while (true) {
		const batch = await ctx.adapter.raw<{
			aggregate_version: number;
			hash: string;
			prev_hash: string | null;
			event_data: Record<string, unknown>;
		}>(
			`SELECT aggregate_version, hash, prev_hash, event_data
       FROM ${t("ledger_event")}
       WHERE aggregate_type = $1
         AND aggregate_id = $2
         AND aggregate_version > $3
       ORDER BY aggregate_version ASC
       LIMIT $4`,
			[aggregateType, aggregateId, lastVersion, VERIFY_BATCH_SIZE],
		);

		if (batch.length === 0) break;

		for (const event of batch) {
			if (!safeEqual(event.prev_hash ?? "", computedPrevHash ?? "")) {
				ctx.logger.error("Hash chain linkage broken -- prevHash mismatch", {
					aggregateType,
					aggregateId,
					version: event.aggregate_version,
					expectedPrevHash: computedPrevHash ?? "null",
					storedPrevHash: event.prev_hash ?? "null",
				});
				return {
					valid: false,
					brokenAtVersion: Number(event.aggregate_version),
					eventCount: totalCount,
				};
			}

			const eventData = (
				typeof event.event_data === "string" ? JSON.parse(event.event_data) : event.event_data
			) as Record<string, unknown>;

			const expectedHash = computeHash(
				computedPrevHash,
				eventData,
				ctx.options.advanced.hmacSecret,
			);
			if (!safeEqual(expectedHash, event.hash)) {
				ctx.logger.error("Hash chain broken -- hash mismatch", {
					aggregateType,
					aggregateId,
					version: event.aggregate_version,
					expected: expectedHash,
					actual: event.hash,
				});
				return {
					valid: false,
					brokenAtVersion: Number(event.aggregate_version),
					eventCount: totalCount,
				};
			}

			computedPrevHash = event.hash;
			totalCount++;
		}

		lastVersion = Number(batch[batch.length - 1]?.aggregate_version);
		if (batch.length < VERIFY_BATCH_SIZE) break;
	}

	return { valid: true, eventCount: totalCount };
}

// =============================================================================
// BLOCK-BASED CHAIN (Azure SQL Ledger pattern)
// =============================================================================
// Each block = batch of events since last checkpoint.
// blockHash = SHA256(prevBlockHash + eventsHash)
// eventsHash = SHA256(sorted event hashes in this block)
//
// O(new events) per checkpoint -- constant time regardless of total aggregates.

/**
 * Create a block checkpoint covering all new events since the last block.
 * Builds a Merkle tree from event hashes for O(log n) proofs.
 * Also stores the linear events_hash for backward compatibility.
 * Returns null if no new events exist.
 */
const BLOCK_HASH_BATCH_SIZE = 1000;

export async function createBlockCheckpoint(ctx: SummaContext): Promise<{
	blockHash: string;
	merkleRoot: string;
	eventCount: number;
	toEventSequence: number;
} | null> {
	const t = createTableResolver(ctx.options.schema);
	return await ctx.adapter.transaction(async (tx) => {
		await tx.raw("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ", []);

		// Get previous block
		const prevBlocks = await tx.raw<{
			id: string;
			block_sequence: number;
			to_event_sequence: number;
			block_hash: string;
		}>(
			`SELECT id, block_sequence, to_event_sequence, block_hash
       FROM ${t("block_checkpoint")}
       ORDER BY block_sequence DESC
       LIMIT 1`,
			[],
		);

		const prev = prevBlocks[0] ?? null;
		const prevMaxSeq = prev ? Number(prev.to_event_sequence) : 0;

		// Check if any new events exist
		const countRows = await tx.raw<{
			cnt: number;
			min_seq: number | null;
			max_seq: number | null;
		}>(
			`SELECT COUNT(*)::int as cnt,
              MIN(sequence_number)::bigint as min_seq,
              MAX(sequence_number)::bigint as max_seq
       FROM ${t("ledger_event")}
       WHERE sequence_number > $1`,
			[prevMaxSeq],
		);

		const countRow = countRows[0];
		if (!countRow || countRow.cnt === 0) {
			ctx.logger.debug("No new events since last block checkpoint");
			return null;
		}

		const eventCount = countRow.cnt;
		const fromSeq = Number(countRow.min_seq);
		const toSeq = Number(countRow.max_seq);

		// Collect all event hashes + IDs for Merkle tree construction
		const allEventHashes: string[] = [];
		const allEventIds: string[] = [];
		const eventsHasher = createHash("sha256");
		let lastSeq = prevMaxSeq;

		while (true) {
			const batch = await tx.raw<{ sequence_number: number; hash: string; id: string }>(
				`SELECT sequence_number, hash, id
         FROM ${t("ledger_event")}
         WHERE sequence_number > $1
         ORDER BY sequence_number ASC
         LIMIT $2`,
				[lastSeq, BLOCK_HASH_BATCH_SIZE],
			);

			if (batch.length === 0) break;

			for (const row of batch) {
				eventsHasher.update(row.hash);
				allEventHashes.push(row.hash);
				allEventIds.push(row.id);
			}

			lastSeq = Number(batch[batch.length - 1]?.sequence_number);
			if (batch.length < BLOCK_HASH_BATCH_SIZE) break;
		}

		// Linear events_hash (backward compat)
		const eventsHash = eventsHasher.digest("hex");

		// Build Merkle tree
		const tree = buildMerkleTree(allEventHashes);

		// blockHash = SHA256(prevBlockHash + eventsHash)
		const prevBlockHash = prev?.block_hash ?? "";
		const blockHash = createHash("sha256")
			.update(prevBlockHash + eventsHash)
			.digest("hex");

		// Insert block checkpoint with merkle_root and tree_depth
		const blockId = randomUUID();
		await tx.raw(
			`INSERT INTO ${t("block_checkpoint")} (id, from_event_sequence, to_event_sequence, event_count, events_hash, block_hash, merkle_root, tree_depth, prev_block_id, prev_block_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
			[
				blockId,
				fromSeq,
				toSeq,
				eventCount,
				eventsHash,
				blockHash,
				tree.root,
				tree.depth,
				prev?.id ?? null,
				prev?.block_hash ?? null,
			],
		);

		// Store Merkle tree nodes — batch INSERT for efficiency
		for (let level = 0; level < tree.levels.length; level++) {
			const nodes = tree.levels[level];
			if (!nodes || nodes.length === 0) continue;

			// Build batch INSERT values
			const placeholders: string[] = [];
			const values: unknown[] = [];
			let paramIdx = 1;

			for (let pos = 0; pos < nodes.length; pos++) {
				const node = nodes[pos];
				if (!node) continue;
				const nodeId = randomUUID();
				// event_id only for leaf nodes (level 0)
				const eventId = level === 0 && pos < allEventIds.length ? allEventIds[pos] : null;

				placeholders.push(
					`($${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2}, $${paramIdx + 3}, $${paramIdx + 4}, $${paramIdx + 5})`,
				);
				values.push(nodeId, blockId, level, pos, node.hash, eventId);
				paramIdx += 6;
			}

			if (placeholders.length > 0) {
				await tx.raw(
					`INSERT INTO ${t("merkle_node")} (id, block_id, level, position, hash, event_id)
           VALUES ${placeholders.join(", ")}`,
					values,
				);
			}
		}

		ctx.logger.info("Block checkpoint created", {
			blockHash,
			merkleRoot: tree.root,
			treeDepth: tree.depth,
			eventCount,
			fromSeq,
			toSeq,
		});

		return { blockHash, merkleRoot: tree.root, eventCount, toEventSequence: toSeq };
	});
}

/**
 * Verify all block checkpoints created since a given date.
 * Called by daily reconciliation to automatically detect block-level tampering.
 * Processes blocks sequentially (chain verification requires ordering).
 */
export async function verifyRecentBlocks(
	ctx: SummaContext,
	sinceDate?: Date,
): Promise<{
	blocksVerified: number;
	blocksValid: number;
	blocksFailed: number;
	failures: Array<{ blockId: string; blockSequence: number; reason: string }>;
}> {
	const t = createTableResolver(ctx.options.schema);
	const since = sinceDate ?? new Date(Date.now() - 48 * 60 * 60 * 1000); // default: last 48h
	const sinceISO = since.toISOString();

	const blocks = await ctx.adapter.raw<{
		id: string;
		block_sequence: number;
		block_at: string | Date;
	}>(
		`SELECT id, block_sequence, block_at
     FROM ${t("block_checkpoint")}
     WHERE block_at >= $1::timestamptz
     ORDER BY block_sequence ASC`,
		[sinceISO],
	);

	let blocksValid = 0;
	let blocksFailed = 0;
	const failures: Array<{ blockId: string; blockSequence: number; reason: string }> = [];

	for (const block of blocks) {
		const result = await verifyBlockCheckpoint(ctx, block.id);

		if (result.valid) {
			blocksValid++;
		} else {
			blocksFailed++;
			const reasons: string[] = [];
			if (result.storedHash !== result.computedHash) {
				reasons.push(`hash mismatch: stored=${result.storedHash}, computed=${result.computedHash}`);
			}
			if (!result.chainValid) {
				reasons.push("chain linkage broken");
			}
			failures.push({
				blockId: block.id,
				blockSequence: Number(block.block_sequence),
				reason: reasons.join("; "),
			});
			ctx.logger.error("Block checkpoint verification FAILED", {
				blockId: block.id,
				blockSequence: block.block_sequence,
				storedHash: result.storedHash,
				computedHash: result.computedHash,
				chainValid: result.chainValid,
			});
		}
	}

	return {
		blocksVerified: blocks.length,
		blocksValid,
		blocksFailed,
		failures,
	};
}

/**
 * Verify a block checkpoint by recomputing from event store data.
 * Uses streaming SHA-256 in batches to avoid loading all hashes.
 * Checks both the events hash and the chain linkage to the previous block.
 */
export async function verifyBlockCheckpoint(
	ctx: SummaContext,
	checkpointId: string,
): Promise<{
	valid: boolean;
	storedHash: string;
	computedHash: string;
	chainValid: boolean;
}> {
	const t = createTableResolver(ctx.options.schema);
	const blockRows = await ctx.adapter.raw<{
		id: string;
		from_event_sequence: number;
		to_event_sequence: number;
		block_hash: string;
		prev_block_id: string | null;
		prev_block_hash: string | null;
	}>(
		`SELECT id, from_event_sequence, to_event_sequence, block_hash, prev_block_id, prev_block_hash
     FROM ${t("block_checkpoint")}
     WHERE id = $1
     LIMIT 1`,
		[checkpointId],
	);

	const block = blockRows[0];
	if (!block) {
		throw new Error(`Block checkpoint ${checkpointId} not found`);
	}

	// Recompute eventsHash from actual event data in streaming batches
	const eventsHasher = createHash("sha256");
	let lastSeq = Number(block.from_event_sequence) - 1;

	while (true) {
		const batch = await ctx.adapter.raw<{
			sequence_number: number;
			hash: string;
		}>(
			`SELECT sequence_number, hash
       FROM ${t("ledger_event")}
       WHERE sequence_number > $1
         AND sequence_number <= $2
       ORDER BY sequence_number ASC
       LIMIT $3`,
			[lastSeq, Number(block.to_event_sequence), BLOCK_HASH_BATCH_SIZE],
		);

		if (batch.length === 0) break;

		for (const row of batch) {
			eventsHasher.update(row.hash);
		}

		lastSeq = Number(batch[batch.length - 1]?.sequence_number);
		if (batch.length < BLOCK_HASH_BATCH_SIZE) break;
	}

	const computedEventsHash = eventsHasher.digest("hex");

	// Verify chain linkage: check prevBlockHash matches actual previous block
	let chainValid = true;
	if (block.prev_block_id) {
		const prevBlockRows = await ctx.adapter.raw<{
			block_hash: string;
		}>(
			`SELECT block_hash
       FROM ${t("block_checkpoint")}
       WHERE id = $1
       LIMIT 1`,
			[block.prev_block_id],
		);

		const prevBlock = prevBlockRows[0];
		if (!prevBlock || !safeEqual(prevBlock.block_hash, block.prev_block_hash ?? "")) {
			chainValid = false;
		}
	} else {
		chainValid = block.prev_block_hash === null;
	}

	// Recompute blockHash
	const prevBlockHash = block.prev_block_hash ?? "";
	const computedBlockHash = createHash("sha256")
		.update(prevBlockHash + computedEventsHash)
		.digest("hex");

	return {
		valid: safeEqual(computedBlockHash, block.block_hash) && chainValid,
		storedHash: block.block_hash,
		computedHash: computedBlockHash,
		chainValid,
	};
}

// =============================================================================
// EXTERNAL ANCHOR VERIFICATION
// =============================================================================

/**
 * Verify a block checkpoint against an externally stored hash.
 * Can verify against either blockHash (legacy) or merkleRoot.
 */
export async function verifyExternalAnchor(
	ctx: SummaContext,
	blockSequence: number,
	externalBlockHash: string,
): Promise<{ valid: boolean; storedHash: string; merkleRoot: string | null }> {
	const t = createTableResolver(ctx.options.schema);
	const rows = await ctx.adapter.raw<{ block_hash: string; merkle_root: string | null }>(
		`SELECT block_hash, merkle_root
     FROM ${t("block_checkpoint")}
     WHERE block_sequence = $1
     LIMIT 1`,
		[blockSequence],
	);

	const block = rows[0];
	if (!block) {
		throw new Error(`Block checkpoint with sequence ${blockSequence} not found`);
	}

	return {
		valid: safeEqual(block.block_hash, externalBlockHash),
		storedHash: block.block_hash,
		merkleRoot: block.merkle_root,
	};
}

// =============================================================================
// MERKLE PROOF — O(log n) proof for a single event
// =============================================================================

/**
 * Generate a Merkle proof for a specific event by its ID.
 * Finds the block containing the event, loads the leaf hashes, and builds
 * the proof from the leaf's position to the root.
 */
export async function generateEventProof(
	ctx: SummaContext,
	eventId: string,
): Promise<MerkleProof & { blockId: string; blockSequence: number }> {
	const t = createTableResolver(ctx.options.schema);

	// Find which block contains this event via the merkle_node leaf
	const leafRows = await ctx.adapter.raw<{
		block_id: string;
		position: number;
	}>(
		`SELECT block_id, position
     FROM ${t("merkle_node")}
     WHERE event_id = $1 AND level = 0
     LIMIT 1`,
		[eventId],
	);

	const leaf = leafRows[0];
	if (!leaf) {
		throw new Error(
			`Event ${eventId} not found in any Merkle tree. Has a block checkpoint been created since this event?`,
		);
	}

	// Get block info
	const blockRows = await ctx.adapter.raw<{
		block_sequence: number;
		from_event_sequence: number;
		to_event_sequence: number;
		merkle_root: string;
	}>(
		`SELECT block_sequence, from_event_sequence, to_event_sequence, merkle_root
     FROM ${t("block_checkpoint")}
     WHERE id = $1`,
		[leaf.block_id],
	);

	const block = blockRows[0];
	if (!block) {
		throw new Error(`Block ${leaf.block_id} not found`);
	}

	// Load all event hashes in this block (ordered by sequence)
	const allLeafHashes: string[] = [];
	let lastSeq = Number(block.from_event_sequence) - 1;

	while (true) {
		const batch = await ctx.adapter.raw<{ sequence_number: number; hash: string }>(
			`SELECT sequence_number, hash
       FROM ${t("ledger_event")}
       WHERE sequence_number > $1
         AND sequence_number <= $2
       ORDER BY sequence_number ASC
       LIMIT $3`,
			[lastSeq, Number(block.to_event_sequence), BLOCK_HASH_BATCH_SIZE],
		);

		if (batch.length === 0) break;

		for (const row of batch) {
			allLeafHashes.push(row.hash);
		}

		lastSeq = Number(batch[batch.length - 1]?.sequence_number);
		if (batch.length < BLOCK_HASH_BATCH_SIZE) break;
	}

	// Generate proof using the leaf's position in the block
	const proof = generateMerkleProof(allLeafHashes, leaf.position);

	return {
		...proof,
		blockId: leaf.block_id,
		blockSequence: Number(block.block_sequence),
	};
}

/**
 * Verify a Merkle proof for an event.
 * Optionally cross-checks against the stored merkle_root in block_checkpoint.
 */
export async function verifyEventProof(
	ctx: SummaContext,
	proof: MerkleProof,
	blockId?: string,
): Promise<{ valid: boolean; rootMatch: boolean }> {
	// First: verify the proof cryptographically
	const proofValid = verifyMerkleProof(proof);

	// If blockId provided, cross-check with stored merkle_root
	let rootMatch = true;
	if (blockId) {
		const t = createTableResolver(ctx.options.schema);
		const rows = await ctx.adapter.raw<{ merkle_root: string }>(
			`SELECT merkle_root FROM ${t("block_checkpoint")} WHERE id = $1 LIMIT 1`,
			[blockId],
		);
		const block = rows[0];
		if (block?.merkle_root) {
			rootMatch = safeEqual(proof.root, block.merkle_root);
		} else {
			rootMatch = false;
		}
	}

	return { valid: proofValid && rootMatch, rootMatch };
}
