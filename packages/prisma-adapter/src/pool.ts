// =============================================================================
// PRISMA CONNECTION POOL GUIDANCE
// =============================================================================
// Prisma manages its own connection pool internally. These constants document
// the recommended settings to pass via the DATABASE_URL or PrismaClient constructor.
//
// Usage:
//   import { RECOMMENDED_PRISMA_CONFIG } from "@summa-ledger/prisma-adapter";
//
//   const prisma = new PrismaClient({
//     datasources: {
//       db: { url: `${process.env.DATABASE_URL}?${RECOMMENDED_PRISMA_URL_PARAMS}` },
//     },
//     transactionOptions: RECOMMENDED_PRISMA_CONFIG.transactionOptions,
//   });

// =============================================================================
// RECOMMENDED CONFIGURATION
// =============================================================================

/**
 * Recommended PrismaClient constructor options for production Summa deployments.
 *
 * @example
 * ```ts
 * import { PrismaClient } from "@prisma/client";
 * import { RECOMMENDED_PRISMA_CONFIG } from "@summa-ledger/prisma-adapter";
 *
 * const prisma = new PrismaClient({
 *   transactionOptions: RECOMMENDED_PRISMA_CONFIG.transactionOptions,
 * });
 * ```
 */
export const RECOMMENDED_PRISMA_CONFIG = {
	/**
	 * Interactive transaction options.
	 * Summa uses long-running interactive transactions for financial operations.
	 */
	transactionOptions: {
		/** Max time to wait for a transaction slot. Default: 5000ms */
		maxWait: 10_000,
		/** Max transaction duration before auto-rollback. Must exceed Summa's transactionTimeoutMs. */
		timeout: 30_000,
		/** Isolation level for financial consistency. */
		isolationLevel: "RepeatableRead" as const,
	},
} as const;

/**
 * Recommended connection string parameters for production use.
 * Append these to your DATABASE_URL as query parameters.
 *
 * @example
 * ```ts
 * const url = `${process.env.DATABASE_URL}?${RECOMMENDED_PRISMA_URL_PARAMS}`;
 * ```
 */
export const RECOMMENDED_PRISMA_URL_PARAMS = [
	"connection_limit=20",
	"pool_timeout=10",
	"connect_timeout=10",
	"statement_cache_size=100",
].join("&");
