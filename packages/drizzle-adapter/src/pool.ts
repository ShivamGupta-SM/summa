// =============================================================================
// CONNECTION POOL CONFIGURATION
// =============================================================================
// Production-ready pool configuration guidance for the Drizzle adapter.
// Provides a factory function that wraps an existing pool with monitoring
// and graceful shutdown, plus recommended pool settings as constants.
//
// Usage:
//   import { createPooledAdapter, RECOMMENDED_POOL_CONFIG } from "@summa/drizzle-adapter";
//   const pool = new Pool({ ...RECOMMENDED_POOL_CONFIG, connectionString: "..." });
//   const { adapter, close, stats } = createPooledAdapter({ pool, drizzle: drizzle(pool) });

import type { SummaAdapter } from "@summa/core/db";
import { drizzleAdapter } from "./adapter.js";

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

export interface PooledAdapterConfig {
	/** A pg.Pool instance (or compatible pool) */
	pool: PoolLike;

	/**
	 * A Drizzle database instance created from the same pool.
	 * e.g. `drizzle(pool)` from `drizzle-orm/node-postgres`
	 */
	// biome-ignore lint/suspicious/noExplicitAny: Drizzle db type varies by driver
	drizzle: any;
}

export interface PooledAdapterResult {
	/** The SummaAdapter instance backed by the pool */
	adapter: SummaAdapter;

	/**
	 * Gracefully shut down the pool. Call this during application shutdown.
	 * Waits for active queries to finish, then closes all connections.
	 */
	close: () => Promise<void>;

	/**
	 * Get current pool stats for monitoring.
	 */
	stats: () => PoolStats;
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
 * import { RECOMMENDED_POOL_CONFIG } from "@summa/drizzle-adapter";
 *
 * const pool = new Pool({
 *   ...RECOMMENDED_POOL_CONFIG,
 *   connectionString: process.env.DATABASE_URL,
 *   // Override as needed:
 *   max: 30,
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
// FACTORY
// =============================================================================

/**
 * Wrap a pool + drizzle instance into a SummaAdapter with monitoring and shutdown.
 *
 * @example
 * ```ts
 * import { Pool } from "pg";
 * import { drizzle } from "drizzle-orm/node-postgres";
 * import { createPooledAdapter, RECOMMENDED_POOL_CONFIG } from "@summa/drizzle-adapter";
 *
 * const pool = new Pool({
 *   ...RECOMMENDED_POOL_CONFIG,
 *   connectionString: process.env.DATABASE_URL!,
 * });
 * const db = drizzle(pool);
 *
 * const { adapter, close, stats } = createPooledAdapter({ pool, drizzle: db });
 * const summa = createSumma({ database: adapter });
 *
 * // Monitor pool health:
 * setInterval(() => console.log(stats()), 60_000);
 *
 * // On shutdown:
 * await summa.workers.stop();
 * await close();
 * ```
 */
export function createPooledAdapter(config: PooledAdapterConfig): PooledAdapterResult {
	const { pool, drizzle: db } = config;
	const adapter = drizzleAdapter(db);

	return {
		adapter,

		close: async () => {
			await pool.end();
		},

		stats: () => ({
			totalCount: pool.totalCount,
			idleCount: pool.idleCount,
			activeCount: pool.totalCount - pool.idleCount,
			waitingCount: pool.waitingCount,
		}),
	};
}
