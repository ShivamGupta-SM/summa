// =============================================================================
// SQL ADAPTER UTILITIES — Shared implementation helpers for SQL-based adapters
// =============================================================================
// This subpath (@summa-ledger/core/sql) contains implementation-level utilities
// used exclusively by SQL adapter packages (drizzle, kysely, prisma).
// Pure abstractions and interfaces live in @summa-ledger/core/db.

// --- Adapter helper utilities ---
export {
	buildWhereClause,
	keysToCamel,
	keysToSnake,
	toCamelCase,
	toSnakeCase,
} from "../db/adapter-utils.js";
// --- Dialect ---
export { postgresDialect } from "../db/dialects/postgres.js";
// --- Pool helpers (implementation, not interface) ---
export {
	createPooledAdapterResult,
	getPoolStats,
	RECOMMENDED_POOL_CONFIG,
} from "../db/pool.js";
// --- Adapter CRUD builder ---
export { buildSqlAdapterMethods, type SqlExecutor } from "../db/sql-adapter-methods.js";
