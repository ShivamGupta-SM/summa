// =============================================================================
// READ REPLICA ADAPTER
// =============================================================================
// Wraps a primary (read-write) and replica (read-only) adapter pair to split
// traffic. Read operations (findOne, findMany, count, raw) are routed to the
// replica by default, while write operations (create, update, delete, rawMutate,
// transaction, advisoryLock) always go to the primary.
//
// Inside a transaction, ALL operations — including reads — go to the primary
// to guarantee read-your-writes consistency.

import type { SortBy, SummaAdapter, SummaTransactionAdapter, Where } from "./adapter.js";

// =============================================================================
// TYPES
// =============================================================================

export interface ReadReplicaOptions {
	/** The primary (read-write) adapter */
	primary: SummaAdapter;

	/** One or more read-only replica adapters. If multiple are provided, a random one is selected per operation. */
	replicas: SummaAdapter[];

	/**
	 * Strategy for selecting among replicas.
	 * - "random": pick a random replica per call (default)
	 * - "round-robin": cycle through replicas sequentially
	 */
	strategy?: "random" | "round-robin";
}

// =============================================================================
// IMPLEMENTATION
// =============================================================================

/**
 * Create a SummaAdapter that routes reads to replica(s) and writes to the primary.
 *
 * @example
 * ```ts
 * import { createReadReplicaAdapter } from "@summa-ledger/core/db";
 * import { drizzleAdapter } from "@summa-ledger/drizzle-adapter";
 *
 * const primary = drizzleAdapter(drizzle(primaryPool));
 * const replica = drizzleAdapter(drizzle(replicaPool));
 *
 * const adapter = createReadReplicaAdapter({
 *   primary,
 *   replicas: [replica],
 * });
 *
 * const summa = createSumma({ database: adapter });
 * ```
 */
export function createReadReplicaAdapter(options: ReadReplicaOptions): SummaAdapter {
	const { primary, replicas, strategy = "random" } = options;

	if (replicas.length === 0) {
		throw new Error("At least one replica adapter is required for read replica setup");
	}

	let roundRobinIndex = 0;

	function getReplica(): SummaAdapter {
		if (replicas.length === 1) {
			return replicas[0] as SummaAdapter;
		}
		if (strategy === "round-robin") {
			const replica = replicas[roundRobinIndex % replicas.length] as SummaAdapter;
			roundRobinIndex++;
			return replica;
		}
		// random
		return replicas[Math.floor(Math.random() * replicas.length)] as SummaAdapter;
	}

	return {
		id: "read-replica",

		options: primary.options,

		// --- READ operations → replica ---

		findOne: async <T>(data: {
			model: string;
			where: Where[];
			forUpdate?: boolean;
		}): Promise<T | null> => {
			// FOR UPDATE requires the primary (it takes row locks)
			if (data.forUpdate) {
				return primary.findOne<T>(data);
			}
			return getReplica().findOne<T>(data);
		},

		findMany: async <T>(data: {
			model: string;
			where?: Where[];
			limit?: number;
			offset?: number;
			sortBy?: SortBy;
		}): Promise<T[]> => {
			return getReplica().findMany<T>(data);
		},

		count: async (data: { model: string; where?: Where[] }): Promise<number> => {
			return getReplica().count(data);
		},

		raw: async <T>(sqlStr: string, params: unknown[]): Promise<T[]> => {
			// Heuristic: if the SQL starts with SELECT (case-insensitive, after whitespace),
			// route to replica. Otherwise, route to primary for safety.
			const trimmed = sqlStr.trimStart().toUpperCase();
			if (trimmed.startsWith("SELECT")) {
				return getReplica().raw<T>(sqlStr, params);
			}
			return primary.raw<T>(sqlStr, params);
		},

		// --- WRITE operations → primary ---

		create: async <T extends Record<string, unknown>>(data: {
			model: string;
			data: T;
		}): Promise<T> => {
			return primary.create<T>(data);
		},

		update: async <T>(data: {
			model: string;
			where: Where[];
			update: Record<string, unknown>;
		}): Promise<T | null> => {
			return primary.update<T>(data);
		},

		delete: async (data: { model: string; where: Where[] }): Promise<void> => {
			return primary.delete(data);
		},

		rawMutate: async (sqlStr: string, params: unknown[]): Promise<number> => {
			return primary.rawMutate(sqlStr, params);
		},

		// --- Transaction & Locking → always primary ---
		// Inside a transaction, ALL operations go through the primary adapter's
		// transaction to ensure read-your-writes consistency.

		transaction: async <T>(fn: (tx: SummaTransactionAdapter) => Promise<T>): Promise<T> => {
			return primary.transaction(fn);
		},

		advisoryLock: async (key: number): Promise<void> => {
			return primary.advisoryLock(key);
		},
	};
}
