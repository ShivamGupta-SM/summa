import { createHash, createHmac } from "node:crypto";
import stringify from "safe-stable-stringify";

const deterministicStringify = stringify.configure({ deterministic: true });

/** Compute SHA-256 hash, using HMAC when a secret is provided. */
function hashPayload(payload: string, secret?: string | null): string {
	if (secret) {
		return createHmac("sha256", secret).update(payload).digest("hex");
	}
	return createHash("sha256").update(payload).digest("hex");
}

// =============================================================================
// MERKLE TREE TYPES
// =============================================================================

export interface MerkleProof {
	leafHash: string;
	leafIndex: number;
	siblings: Array<{ hash: string; direction: "left" | "right" }>;
	root: string;
}

/**
 * Compute hash for an event in the chain.
 *
 * When `secret` is provided, uses HMAC-SHA256 for tamper-proof hashing —
 * an attacker with DB access cannot recompute valid hashes without the key.
 * Without `secret`, uses plain SHA-256.
 *
 * Uses deterministic (sorted-key) serialization to ensure consistency
 * after JSONB round-trips through PostgreSQL.
 */
export function computeHash(
	prevHash: string | null,
	eventData: Record<string, unknown>,
	secret?: string | null,
): string {
	// Normalize to match JSONB round-trip behavior
	const normalized = structuredClone(eventData);
	const payload = (prevHash ?? "") + (deterministicStringify(normalized) as string);

	return hashPayload(payload, secret);
}

/**
 * Compute a checksum for account balance state.
 * Used to detect direct DB tampering of balance fields.
 */
export function computeBalanceChecksum(
	fields: {
		balance: number;
		creditBalance: number;
		debitBalance: number;
		pendingDebit: number;
		pendingCredit: number;
		lockVersion: number;
	},
	secret?: string | null,
): string {
	const payload = deterministicStringify(fields) as string;
	return hashPayload(payload, secret);
}

// =============================================================================
// MERKLE TREE — O(log n) proofs for block-level verification
// =============================================================================

/**
 * Compute the Merkle root from an array of leaf hashes.
 * Builds the binary tree bottom-up. Odd leaves are duplicated.
 * Returns the root hash.
 */
export function computeMerkleRoot(leafHashes: string[]): string {
	if (leafHashes.length === 0) {
		return createHash("sha256").update("").digest("hex");
	}

	let level = [...leafHashes];

	while (level.length > 1) {
		const nextLevel: string[] = [];

		for (let i = 0; i < level.length; i += 2) {
			const left = level[i] as string;
			// If odd number of nodes, duplicate the last one
			const right = i + 1 < level.length ? (level[i + 1] as string) : left;
			nextLevel.push(
				createHash("sha256")
					.update(left + right)
					.digest("hex"),
			);
		}

		level = nextLevel;
	}

	return level[0] as string;
}

/**
 * Generate a Merkle proof for a specific leaf by index.
 * The proof consists of sibling hashes along the path from leaf to root.
 * With ~20 sibling hashes, you can verify any event among 1M events.
 */
export function generateMerkleProof(leafHashes: string[], leafIndex: number): MerkleProof {
	if (leafIndex < 0 || leafIndex >= leafHashes.length) {
		throw new Error(`Leaf index ${leafIndex} out of range [0, ${leafHashes.length})`);
	}

	const siblings: Array<{ hash: string; direction: "left" | "right" }> = [];
	let level = [...leafHashes];
	let idx = leafIndex;

	while (level.length > 1) {
		const nextLevel: string[] = [];

		for (let i = 0; i < level.length; i += 2) {
			const left = level[i] as string;
			const right = i + 1 < level.length ? (level[i + 1] as string) : left;

			// If our index is in this pair, record the sibling
			if (i === idx || i + 1 === idx) {
				if (idx % 2 === 0) {
					// We're on the left, sibling is on the right
					siblings.push({ hash: right, direction: "right" });
				} else {
					// We're on the right, sibling is on the left
					siblings.push({ hash: left, direction: "left" });
				}
			}

			nextLevel.push(
				createHash("sha256")
					.update(left + right)
					.digest("hex"),
			);
		}

		level = nextLevel;
		idx = Math.floor(idx / 2);
	}

	return {
		leafHash: leafHashes[leafIndex] as string,
		leafIndex,
		siblings,
		root: level[0] as string,
	};
}

/**
 * Verify a Merkle proof by recomputing the root from the leaf + siblings.
 * Returns true if the recomputed root matches the proof's root.
 */
export function verifyMerkleProof(proof: MerkleProof): boolean {
	let currentHash = proof.leafHash;

	for (const sibling of proof.siblings) {
		if (sibling.direction === "right") {
			// Sibling is on the right: hash(current + sibling)
			currentHash = createHash("sha256")
				.update(currentHash + sibling.hash)
				.digest("hex");
		} else {
			// Sibling is on the left: hash(sibling + current)
			currentHash = createHash("sha256")
				.update(sibling.hash + currentHash)
				.digest("hex");
		}
	}

	return currentHash === proof.root;
}

/**
 * Build a full Merkle tree and return all nodes organized by level.
 * Level 0 = leaves, max level = root.
 * Used by createBlockCheckpoint to store the tree structure in merkle_node table.
 */
export function buildMerkleTree(leafHashes: string[]): {
	root: string;
	depth: number;
	levels: Array<Array<{ hash: string; leftChildIndex?: number; rightChildIndex?: number }>>;
} {
	if (leafHashes.length === 0) {
		const emptyRoot = createHash("sha256").update("").digest("hex");
		return { root: emptyRoot, depth: 0, levels: [[{ hash: emptyRoot }]] };
	}

	const levels: Array<Array<{ hash: string; leftChildIndex?: number; rightChildIndex?: number }>> =
		[];

	// Level 0: leaf nodes
	levels.push(leafHashes.map((hash) => ({ hash })));

	let currentLevel = [...leafHashes];

	while (currentLevel.length > 1) {
		const nextLevel: string[] = [];
		const nextLevelNodes: Array<{ hash: string; leftChildIndex: number; rightChildIndex: number }> =
			[];

		for (let i = 0; i < currentLevel.length; i += 2) {
			const left = currentLevel[i] as string;
			const right = i + 1 < currentLevel.length ? (currentLevel[i + 1] as string) : left;
			const hash = createHash("sha256")
				.update(left + right)
				.digest("hex");

			nextLevel.push(hash);
			nextLevelNodes.push({
				hash,
				leftChildIndex: i,
				rightChildIndex: i + 1 < currentLevel.length ? i + 1 : i,
			});
		}

		levels.push(nextLevelNodes);
		currentLevel = nextLevel;
	}

	return {
		root: currentLevel[0] as string,
		depth: levels.length - 1,
		levels,
	};
}
