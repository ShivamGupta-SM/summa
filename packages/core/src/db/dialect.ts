// =============================================================================
// SQL DIALECT INTERFACE
// =============================================================================
// Abstracts database-specific SQL generation so that managers and plugins
// can emit portable SQL. Each supported database provides its own implementation.

export interface SqlDialect {
	/** Dialect identifier. */
	readonly name: "postgres" | "mysql" | "sqlite";

	/** Advisory lock statement (transaction-scoped). Returns empty string if unsupported. */
	advisoryLock(key: number): string;

	/** Row-level lock suffix, e.g. "FOR UPDATE". */
	forUpdate(): string;

	/** Row-level lock that skips already-locked rows. */
	forUpdateSkipLocked(): string;

	/** Generate a UUID value server-side. */
	generateUuid(): string;

	/** UPSERT: do nothing on conflict with the given columns. */
	onConflictDoNothing(conflictColumns: string[]): string;

	/** UPSERT: update specific columns on conflict. */
	onConflictDoUpdate(conflictColumns: string[], updates: Record<string, string>): string;

	/** RETURNING clause for INSERT/UPDATE/DELETE. */
	returning(columns: string[]): string;

	/** Current timestamp expression. */
	now(): string;

	/** Interval expression, e.g. "INTERVAL '5 minutes'". */
	interval(value: string): string;

	/** Cast COUNT(*) to integer (some dialects return bigint string). */
	countAsInt(): string;

	/** Positional parameter placeholder. 1-indexed: paramPlaceholder(1) → "$1" or "?". */
	paramPlaceholder(index: number): string;

	/** SET statement_timeout (connection-level). Returns empty string if unsupported. */
	setStatementTimeout(ms: number): string;

	/** SET lock_timeout (connection-level). Returns empty string if unsupported. */
	setLockTimeout(ms: number): string;
}
