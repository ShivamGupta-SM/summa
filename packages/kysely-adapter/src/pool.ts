// =============================================================================
// CONNECTION POOL CONFIGURATION
// =============================================================================
// Production-ready pool configuration guidance for the Kysely adapter.
// Pool types, constants, and helpers are shared from @summa-ledger/core/db.

import type { PooledAdapterResult, PoolLike } from "@summa-ledger/core/db";
import { createPooledAdapterResult } from "@summa-ledger/core/sql";
import type { Kysely } from "kysely";
import { kyselyAdapter } from "./adapter.js";

// Re-export shared pool types and constants for convenience
export type { PooledAdapterResult, PoolLike, PoolStats } from "@summa-ledger/core/db";
export { RECOMMENDED_POOL_CONFIG } from "@summa-ledger/core/sql";

export interface KyselyPooledAdapterConfig {
	/** A pg.Pool instance (or compatible pool) */
	pool: PoolLike;
	/** A Kysely database instance created from the same pool */
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic type varies by schema
	db: Kysely<any>;
}

/**
 * Wrap a pool + Kysely instance into a SummaAdapter with monitoring and shutdown.
 *
 * @example
 * ```ts
 * import { Pool } from "pg";
 * import { Kysely, PostgresDialect } from "kysely";
 * import { createPooledAdapter, RECOMMENDED_POOL_CONFIG } from "@summa-ledger/kysely-adapter";
 *
 * const pool = new Pool({
 *   ...RECOMMENDED_POOL_CONFIG,
 *   connectionString: process.env.DATABASE_URL!,
 * });
 * const db = new Kysely({ dialect: new PostgresDialect({ pool }) });
 *
 * const { adapter, close, stats } = createPooledAdapter({ pool, db });
 * const summa = createSumma({ database: adapter });
 *
 * // On shutdown:
 * await summa.workers.stop();
 * await close();
 * ```
 */
export function createPooledAdapter(config: KyselyPooledAdapterConfig): PooledAdapterResult {
	const { pool, db } = config;
	const adapter = kyselyAdapter(db);
	return createPooledAdapterResult(adapter, pool, () => db.destroy());
}
