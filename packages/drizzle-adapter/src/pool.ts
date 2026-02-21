// =============================================================================
// CONNECTION POOL CONFIGURATION
// =============================================================================
// Production-ready pool configuration guidance for the Drizzle adapter.
// Pool types, constants, and helpers are shared from @summa/core/db.

import { createPooledAdapterResult, type PooledAdapterResult, type PoolLike } from "@summa/core/db";
import { drizzleAdapter } from "./adapter.js";

// Re-export shared pool types and constants for convenience
export {
	type PooledAdapterResult,
	type PoolLike,
	type PoolStats,
	RECOMMENDED_POOL_CONFIG,
} from "@summa/core/db";

export interface DrizzlePooledAdapterConfig {
	/** A pg.Pool instance (or compatible pool) */
	pool: PoolLike;

	/**
	 * A Drizzle database instance created from the same pool.
	 * e.g. `drizzle(pool)` from `drizzle-orm/node-postgres`
	 */
	// biome-ignore lint/suspicious/noExplicitAny: Drizzle db type varies by driver
	drizzle: any;
}

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
export function createPooledAdapter(config: DrizzlePooledAdapterConfig): PooledAdapterResult {
	const { pool, drizzle: db } = config;
	const adapter = drizzleAdapter(db);
	return createPooledAdapterResult(adapter, pool);
}
