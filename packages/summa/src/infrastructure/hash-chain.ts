// =============================================================================
// HASH CHAIN -- Cryptographic tamper detection
// =============================================================================
// Each entry's hash = SHA-256(prevHash + entryData).
// Provides per-account tamper detection + block-based chain checkpoints.
//
// Design: Azure SQL Ledger pattern -- blocks of entries chained via prevBlockHash.
// O(new entries) per checkpoint, not O(all accounts). Scales forever.

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { SummaContext } from "@summa-ledger/core";
import {
	buildMerkleTree,
	computeHash,
	generateMerkleProof,
	type MerkleProof,
	verifyMerkleProof,
} from "@summa-ledger/core";
import { createTableResolver } from "@summa-ledger/core/db";

/** Constant-time string comparison to prevent timing attacks on hash verification. */
function safeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// =============================================================================
// CHAIN VERIFICATION
// =============================================================================

const VERIFY_BATCH_SIZE = 500;

/**
 * Verify the hash chain for a specific account.
 * Processes in batches of 500 to avoid loading all entries into memory.
 */
export async function verifyHashChain(
	ctx: SummaContext,
	_aggregateType: string,
	accountId: string,
	_ledgerId: string,
): Promise<{ valid: boolean; brokenAtVersion?: number; eventCount: number }> {
	return verifyHashChainFrom(ctx, _aggregateType, accountId, _ledgerId, -1, null);
}

/**
 * Verify the hash chain for a specific account starting from a given sequence.
 * Used internally by verifyHashChain (full scan) and by hash-snapshot (partial scan).
 */
export async function verifyHashChainFrom(
	ctx: SummaContext,
	_aggregateType: string,
	accountId: string,
	_ledgerId: string,
	fromSequence: number,
	initialPrevHash: string | null,
): Promise<{ valid: boolean; brokenAtVersion?: number; eventCount: number }> {
	const t = createTableResolver(ctx.options.schema);
	let computedPrevHash: string | null = initialPrevHash;
	let totalCount = 0;
	let lastSeq = fromSequence;

	while (true) {
		const batch = await ctx.adapter.raw<{
			sequence_number: number;
			hash: string;
			prev_hash: string | null;
			transfer_id: string;
			account_id: string;
			entry_type: string;
			amount: number;
			currency: string;
			balance_before: number | null;
			balance_after: number | null;
			account_version: number | null;
		}>(
			`SELECT sequence_number, hash, prev_hash, transfer_id, account_id,
              entry_type, amount, currency, balance_before, balance_after, account_version
       FROM ${t("entry")}
       WHERE account_id = $1
         AND sequence_number > $2
       ORDER BY sequence_number ASC
       LIMIT $3`,
			[accountId, lastSeq, VERIFY_BATCH_SIZE],
		);

		if (batch.length === 0) break;

		for (const entry of batch) {
			if (!safeEqual(entry.prev_hash ?? "", computedPrevHash ?? "")) {
				ctx.logger.error("Hash chain linkage broken -- prevHash mismatch", {
					accountId,
					sequenceNumber: entry.sequence_number,
					expectedPrevHash: computedPrevHash ?? "null",
					storedPrevHash: entry.prev_hash ?? "null",
				});
				return {
					valid: false,
					brokenAtVersion: Number(entry.sequence_number),
					eventCount: totalCount,
				};
			}

			// Reconstruct entry data for hash computation
			const entryData: Record<string, unknown> = entry.balance_before != null
				? {
						transferId: entry.transfer_id,
						accountId: entry.account_id,
						entryType: entry.entry_type,
						amount: Number(entry.amount),
						currency: entry.currency,
						balanceBefore: Number(entry.balance_before),
						balanceAfter: Number(entry.balance_after),
						version: Number(entry.account_version),
					}
				: {
						transferId: entry.transfer_id,
						accountId: entry.account_id,
						entryType: entry.entry_type,
						amount: Number(entry.amount),
						currency: entry.currency,
						isHot: true,
					};

			const expectedHash = computeHash(
				computedPrevHash,
				entryData,
				ctx.options.advanced.hmacSecret,
			);
			if (!safeEqual(expectedHash, entry.hash)) {
				ctx.logger.error("Hash chain broken -- hash mismatch", {
					accountId,
					sequenceNumber: entry.sequence_number,
					expected: expectedHash,
					actual: entry.hash,
				});
				return {
					valid: false,
					brokenAtVersion: Number(entry.sequence_number),
					eventCount: totalCount,
				};
			}

			computedPrevHash = entry.hash;
			totalCount++;
		}

		lastSeq = Number(batch[batch.length - 1]?.sequence_number);
		if (batch.length < VERIFY_BATCH_SIZE) break;
	}

	return { valid: true, eventCount: totalCount };
}

// =============================================================================
// CHECKPOINT-AWARE CHAIN VERIFICATION
// =============================================================================

export async function verifyHashChainFromCheckpoint(
	ctx: SummaContext,
	_aggregateType: string,
	accountId: string,
	ledgerId: string,
): Promise<{
	valid: boolean;
	brokenAtVersion?: number;
	eventCount: number;
	skippedViaCheckpoint: number;
}> {
	const t = createTableResolver(ctx.options.schema);

	// Find latest block checkpoint for this ledger
	const checkpointRows = await ctx.adapter.raw<{
		to_entry_sequence: number;
	}>(
		`SELECT to_entry_sequence
		 FROM ${t("block_checkpoint")}
		 WHERE ledger_id = $1
		 ORDER BY block_sequence DESC
		 LIMIT 1`,
		[ledgerId],
	);

	const checkpoint = checkpointRows[0];
	let skippedViaCheckpoint = 0;
	let computedPrevHash: string | null = null;

	if (checkpoint) {
		const toSeq = Number(checkpoint.to_entry_sequence);

		const coveredRows = await ctx.adapter.raw<{
			cnt: number;
			last_hash: string | null;
		}>(
			`SELECT
				COUNT(*)::int AS cnt,
				(SELECT hash FROM ${t("entry")}
				 WHERE account_id = $1
				   AND sequence_number <= $2
				 ORDER BY sequence_number DESC LIMIT 1) AS last_hash
			 FROM ${t("entry")}
			 WHERE account_id = $1
			   AND sequence_number <= $2`,
			[accountId, toSeq],
		);

		if (coveredRows[0] && coveredRows[0].cnt > 0) {
			skippedViaCheckpoint = coveredRows[0].cnt;
			computedPrevHash = coveredRows[0].last_hash;
		}
	}

	// Verify remaining entries after checkpoint
	let totalCount = skippedViaCheckpoint;
	let lastSeq = -1;

	const seqFilter = checkpoint
		? ` AND sequence_number > ${Number(checkpoint.to_entry_sequence)}`
		: "";

	while (true) {
		const batch = await ctx.adapter.raw<{
			sequence_number: number;
			hash: string;
			prev_hash: string | null;
			transfer_id: string;
			account_id: string;
			entry_type: string;
			amount: number;
			currency: string;
			balance_before: number | null;
			balance_after: number | null;
			account_version: number | null;
		}>(
			`SELECT sequence_number, hash, prev_hash, transfer_id, account_id,
              entry_type, amount, currency, balance_before, balance_after, account_version
			 FROM ${t("entry")}
			 WHERE account_id = $1
			   AND sequence_number > $2
			   ${seqFilter}
			 ORDER BY sequence_number ASC
			 LIMIT $3`,
			[accountId, lastSeq, VERIFY_BATCH_SIZE],
		);

		if (batch.length === 0) break;

		for (const entry of batch) {
			if (!safeEqual(entry.prev_hash ?? "", computedPrevHash ?? "")) {
				return {
					valid: false,
					brokenAtVersion: Number(entry.sequence_number),
					eventCount: totalCount,
					skippedViaCheckpoint,
				};
			}

			const entryData: Record<string, unknown> = entry.balance_before != null
				? {
						transferId: entry.transfer_id,
						accountId: entry.account_id,
						entryType: entry.entry_type,
						amount: Number(entry.amount),
						currency: entry.currency,
						balanceBefore: Number(entry.balance_before),
						balanceAfter: Number(entry.balance_after),
						version: Number(entry.account_version),
					}
				: {
						transferId: entry.transfer_id,
						accountId: entry.account_id,
						entryType: entry.entry_type,
						amount: Number(entry.amount),
						currency: entry.currency,
						isHot: true,
					};

			const expectedHash = computeHash(
				computedPrevHash,
				entryData,
				ctx.options.advanced.hmacSecret,
			);

			if (!safeEqual(expectedHash, entry.hash)) {
				return {
					valid: false,
					brokenAtVersion: Number(entry.sequence_number),
					eventCount: totalCount,
					skippedViaCheckpoint,
				};
			}

			computedPrevHash = entry.hash;
			totalCount++;
		}

		lastSeq = Number(batch[batch.length - 1]?.sequence_number);
		if (batch.length < VERIFY_BATCH_SIZE) break;
	}

	return { valid: true, eventCount: totalCount, skippedViaCheckpoint };
}

export async function getLatestSealedSequence(
	ctx: SummaContext,
	ledgerId: string,
): Promise<number> {
	const t = createTableResolver(ctx.options.schema);
	const rows = await ctx.adapter.raw<{ max_seq: number }>(
		`SELECT COALESCE(MAX(to_entry_sequence), 0)::bigint AS max_seq
		 FROM ${t("block_checkpoint")} WHERE ledger_id = $1`,
		[ledgerId],
	);
	return Number(rows[0]?.max_seq ?? 0);
}

// =============================================================================
// BLOCK-BASED CHAIN (Azure SQL Ledger pattern)
// =============================================================================

const BLOCK_HASH_BATCH_SIZE = 1000;

/**
 * Create a block checkpoint covering all new entries since the last block.
 * Builds a Merkle tree from entry hashes for O(log n) proofs.
 */
export async function createBlockCheckpoint(
	ctx: SummaContext,
	ledgerId: string,
): Promise<{
	blockHash: string;
	merkleRoot: string;
	eventCount: number;
	toEntrySequence: number;
} | null> {
	const t = createTableResolver(ctx.options.schema);
	return await ctx.adapter.transaction(async (tx) => {
		await tx.raw("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ", []);

		const prevBlocks = await tx.raw<{
			id: string;
			block_sequence: number;
			to_entry_sequence: number;
			block_hash: string;
		}>(
			`SELECT id, block_sequence, to_entry_sequence, block_hash
       FROM ${t("block_checkpoint")}
       WHERE ledger_id = $1
       ORDER BY block_sequence DESC
       LIMIT 1`,
			[ledgerId],
		);

		const prev = prevBlocks[0] ?? null;
		const prevMaxSeq = prev ? Number(prev.to_entry_sequence) : 0;

		// Check if any new entries exist
		const countRows = await tx.raw<{
			cnt: number;
			min_seq: number | null;
			max_seq: number | null;
		}>(
			`SELECT COUNT(*)::int as cnt,
              MIN(sequence_number)::bigint as min_seq,
              MAX(sequence_number)::bigint as max_seq
       FROM ${t("entry")}
       WHERE sequence_number > $1`,
			[prevMaxSeq],
		);

		const countRow = countRows[0];
		if (!countRow || countRow.cnt === 0) {
			ctx.logger.debug("No new entries since last block checkpoint");
			return null;
		}

		const eventCount = countRow.cnt;
		const fromSeq = Number(countRow.min_seq);
		const toSeq = Number(countRow.max_seq);

		// Collect all entry hashes for Merkle tree
		const allEntryHashes: string[] = [];
		const allEntryIds: string[] = [];
		const entriesHasher = createHash("sha256");
		let lastSeq = prevMaxSeq;

		while (true) {
			const batch = await tx.raw<{ sequence_number: number; hash: string; id: string }>(
				`SELECT sequence_number, hash, id
         FROM ${t("entry")}
         WHERE sequence_number > $1
         ORDER BY sequence_number ASC
         LIMIT $2`,
				[lastSeq, BLOCK_HASH_BATCH_SIZE],
			);

			if (batch.length === 0) break;

			for (const row of batch) {
				entriesHasher.update(row.hash);
				allEntryHashes.push(row.hash);
				allEntryIds.push(row.id);
			}

			lastSeq = Number(batch[batch.length - 1]?.sequence_number);
			if (batch.length < BLOCK_HASH_BATCH_SIZE) break;
		}

		const entriesHash = entriesHasher.digest("hex");
		const tree = buildMerkleTree(allEntryHashes);

		const prevBlockHash = prev?.block_hash ?? "";
		const blockHash = createHash("sha256")
			.update(prevBlockHash + entriesHash)
			.digest("hex");

		const blockId = randomUUID();
		await tx.raw(
			`INSERT INTO ${t("block_checkpoint")} (id, ledger_id, from_entry_sequence, to_entry_sequence, event_count, events_hash, block_hash, merkle_root, tree_depth, prev_block_id, prev_block_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
			[
				blockId,
				ledgerId,
				fromSeq,
				toSeq,
				eventCount,
				entriesHash,
				blockHash,
				tree.root,
				tree.depth,
				prev?.id ?? null,
				prev?.block_hash ?? null,
			],
		);

		// Store Merkle tree nodes
		for (let level = 0; level < tree.levels.length; level++) {
			const nodes = tree.levels[level];
			if (!nodes || nodes.length === 0) continue;

			const placeholders: string[] = [];
			const values: unknown[] = [];
			let paramIdx = 1;

			for (let pos = 0; pos < nodes.length; pos++) {
				const node = nodes[pos];
				if (!node) continue;
				const nodeId = randomUUID();
				const entryId = level === 0 && pos < allEntryIds.length ? allEntryIds[pos] : null;

				placeholders.push(
					`($${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2}, $${paramIdx + 3}, $${paramIdx + 4}, $${paramIdx + 5})`,
				);
				values.push(nodeId, blockId, level, pos, node.hash, entryId);
				paramIdx += 6;
			}

			if (placeholders.length > 0) {
				await tx.raw(
					`INSERT INTO ${t("merkle_node")} (id, block_id, level, position, hash, entry_id)
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

		return { blockHash, merkleRoot: tree.root, eventCount, toEntrySequence: toSeq };
	});
}

// =============================================================================
// BLOCK VERIFICATION
// =============================================================================

export async function verifyRecentBlocks(
	ctx: SummaContext,
	ledgerId: string,
	sinceDate?: Date,
): Promise<{
	blocksVerified: number;
	blocksValid: number;
	blocksFailed: number;
	failures: Array<{ blockId: string; blockSequence: number; reason: string }>;
}> {
	const t = createTableResolver(ctx.options.schema);
	const since = sinceDate ?? new Date(Date.now() - 48 * 60 * 60 * 1000);
	const sinceISO = since.toISOString();

	const blocks = await ctx.adapter.raw<{
		id: string;
		block_sequence: number;
		block_at: string | Date;
	}>(
		`SELECT id, block_sequence, block_at
     FROM ${t("block_checkpoint")}
     WHERE ledger_id = $1 AND block_at >= $2::timestamptz
     ORDER BY block_sequence ASC`,
		[ledgerId, sinceISO],
	);

	let blocksValid = 0;
	let blocksFailed = 0;
	const failures: Array<{ blockId: string; blockSequence: number; reason: string }> = [];

	for (const block of blocks) {
		const result = await verifyBlockCheckpoint(ctx, block.id, ledgerId);

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
		}
	}

	return { blocksVerified: blocks.length, blocksValid, blocksFailed, failures };
}

export async function verifyBlockCheckpoint(
	ctx: SummaContext,
	checkpointId: string,
	_ledgerId: string,
): Promise<{
	valid: boolean;
	storedHash: string;
	computedHash: string;
	chainValid: boolean;
}> {
	const t = createTableResolver(ctx.options.schema);
	const blockRows = await ctx.adapter.raw<{
		id: string;
		from_entry_sequence: number;
		to_entry_sequence: number;
		block_hash: string;
		prev_block_id: string | null;
		prev_block_hash: string | null;
	}>(
		`SELECT id, from_entry_sequence, to_entry_sequence, block_hash, prev_block_id, prev_block_hash
     FROM ${t("block_checkpoint")}
     WHERE id = $1
     LIMIT 1`,
		[checkpointId],
	);

	const block = blockRows[0];
	if (!block) {
		throw new Error(`Block checkpoint ${checkpointId} not found`);
	}

	const entriesHasher = createHash("sha256");
	let lastSeq = Number(block.from_entry_sequence) - 1;

	while (true) {
		const batch = await ctx.adapter.raw<{
			sequence_number: number;
			hash: string;
		}>(
			`SELECT sequence_number, hash
       FROM ${t("entry")}
       WHERE sequence_number > $1
         AND sequence_number <= $2
       ORDER BY sequence_number ASC
       LIMIT $3`,
			[lastSeq, Number(block.to_entry_sequence), BLOCK_HASH_BATCH_SIZE],
		);

		if (batch.length === 0) break;

		for (const row of batch) {
			entriesHasher.update(row.hash);
		}

		lastSeq = Number(batch[batch.length - 1]?.sequence_number);
		if (batch.length < BLOCK_HASH_BATCH_SIZE) break;
	}

	const computedEntriesHash = entriesHasher.digest("hex");

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

	const prevBlockHash = block.prev_block_hash ?? "";
	const computedBlockHash = createHash("sha256")
		.update(prevBlockHash + computedEntriesHash)
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

export async function verifyExternalAnchor(
	ctx: SummaContext,
	blockSequence: number,
	externalHash: string,
	ledgerId: string,
): Promise<{ valid: boolean; storedBlockHash: string; storedMerkleRoot: string | null }> {
	const t = createTableResolver(ctx.options.schema);
	const rows = await ctx.adapter.raw<{ block_hash: string; merkle_root: string | null }>(
		`SELECT block_hash, merkle_root
     FROM ${t("block_checkpoint")}
     WHERE ledger_id = $1 AND block_sequence = $2
     LIMIT 1`,
		[ledgerId, blockSequence],
	);

	const block = rows[0];
	if (!block) {
		throw new Error(`Block checkpoint with sequence ${blockSequence} not found`);
	}

	const matchesBlockHash = safeEqual(block.block_hash, externalHash);
	const matchesMerkleRoot = block.merkle_root ? safeEqual(block.merkle_root, externalHash) : false;

	return {
		valid: matchesBlockHash || matchesMerkleRoot,
		storedBlockHash: block.block_hash,
		storedMerkleRoot: block.merkle_root,
	};
}

// =============================================================================
// MERKLE PROOF — O(log n) proof for a single entry
// =============================================================================

export async function generateEventProof(
	ctx: SummaContext,
	entryId: string,
	_ledgerId: string,
): Promise<MerkleProof & { blockId: string; blockSequence: number }> {
	const t = createTableResolver(ctx.options.schema);

	const leafRows = await ctx.adapter.raw<{
		block_id: string;
		position: number;
	}>(
		`SELECT block_id, position
     FROM ${t("merkle_node")}
     WHERE entry_id = $1 AND level = 0
     LIMIT 1`,
		[entryId],
	);

	const leaf = leafRows[0];
	if (!leaf) {
		throw new Error(
			`Entry ${entryId} not found in any Merkle tree. Has a block checkpoint been created since this entry?`,
		);
	}

	const blockRows = await ctx.adapter.raw<{
		block_sequence: number;
		from_entry_sequence: number;
		to_entry_sequence: number;
		merkle_root: string;
	}>(
		`SELECT block_sequence, from_entry_sequence, to_entry_sequence, merkle_root
     FROM ${t("block_checkpoint")}
     WHERE id = $1`,
		[leaf.block_id],
	);

	const block = blockRows[0];
	if (!block) {
		throw new Error(`Block ${leaf.block_id} not found`);
	}

	const allLeafHashes: string[] = [];
	let lastSeq = Number(block.from_entry_sequence) - 1;

	while (true) {
		const batch = await ctx.adapter.raw<{ sequence_number: number; hash: string }>(
			`SELECT sequence_number, hash
       FROM ${t("entry")}
       WHERE sequence_number > $1
         AND sequence_number <= $2
       ORDER BY sequence_number ASC
       LIMIT $3`,
			[lastSeq, Number(block.to_entry_sequence), BLOCK_HASH_BATCH_SIZE],
		);

		if (batch.length === 0) break;

		for (const row of batch) {
			allLeafHashes.push(row.hash);
		}

		lastSeq = Number(batch[batch.length - 1]?.sequence_number);
		if (batch.length < BLOCK_HASH_BATCH_SIZE) break;
	}

	const proof = generateMerkleProof(allLeafHashes, leaf.position);

	return {
		...proof,
		blockId: leaf.block_id,
		blockSequence: Number(block.block_sequence),
	};
}

export async function verifyEventProof(
	ctx: SummaContext,
	proof: MerkleProof,
	blockId?: string,
): Promise<{ valid: boolean; rootMatch: boolean }> {
	const proofValid = verifyMerkleProof(proof);

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
