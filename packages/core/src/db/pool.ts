// =============================================================================
// POOL TYPES & CONSTANTS — Shared across SQL adapter pool modules
// =============================================================================

import type { SummaAdapter } from "./adapter.js";

// =============================================================================
// TYPES
// =============================================================================

/**
 * Minimal interface for a pg-compatible connection pool.
 * Matches the `pg.Pool` API surface we need without importing `pg` types.
 */
export interface PoolLike {
	end(): Promise<void>;
	totalCount: number;
	idleCount: number;
	waitingCount: number;
}

export interface PoolStats {
	/** Total number of clients in the pool */
	totalCount: number;
	/** Number of idle clients */
	idleCount: number;
	/** Number of clients checked out (in use) */
	activeCount: number;
	/** Number of clients waiting for a connection */
	waitingCount: number;
}

export interface PooledAdapterResult {
	/** The SummaAdapter instance backed by the pool */
	adapter: SummaAdapter;
	/** Gracefully shut down the pool. Call this during application shutdown. */
	close: () => Promise<void>;
	/** Get current pool stats for monitoring. */
	stats: () => PoolStats;
}

// =============================================================================
// RECOMMENDED POOL SETTINGS
// =============================================================================

/**
 * Recommended pool configuration for production Summa deployments.
 * Spread these into your `new Pool()` constructor and override as needed.
 *
 * @example
 * ```ts
 * import { Pool } from "pg";
 * import { RECOMMENDED_POOL_CONFIG } from "@summa/core/db";
 *
 * const pool = new Pool({
 *   ...RECOMMENDED_POOL_CONFIG,
 *   connectionString: process.env.DATABASE_URL,
 * });
 * ```
 */
export const RECOMMENDED_POOL_CONFIG = {
	/** Maximum number of clients. For multi-instance: divide by instance count. */
	max: 20,
	/** Minimum idle clients kept warm. */
	min: 5,
	/** Close idle clients after 30s. */
	idleTimeoutMillis: 30_000,
	/** Fail fast if no connection available within 10s. */
	connectionTimeoutMillis: 10_000,
	/** Recycle connections after 30min to avoid stale connections behind LBs. */
	maxLifetimeMillis: 1_800_000,
	/** Prevent runaway queries (30s). */
	statement_timeout: 30_000,
} as const;

// =============================================================================
// HELPER
// =============================================================================

/** Build PoolStats from a PoolLike instance. */
export function getPoolStats(pool: PoolLike): PoolStats {
	return {
		totalCount: pool.totalCount,
		idleCount: pool.idleCount,
		activeCount: pool.totalCount - pool.idleCount,
		waitingCount: pool.waitingCount,
	};
}

/**
 * Create a PooledAdapterResult from an adapter, pool, and optional destroy function.
 * The destroy function is called before pool.end() — used by Kysely to call db.destroy().
 */
export function createPooledAdapterResult(
	adapter: SummaAdapter,
	pool: PoolLike,
	destroyFn?: () => Promise<void>,
): PooledAdapterResult {
	return {
		adapter,
		close: async () => {
			if (destroyFn) await destroyFn();
			await pool.end();
		},
		stats: () => getPoolStats(pool),
	};
}
