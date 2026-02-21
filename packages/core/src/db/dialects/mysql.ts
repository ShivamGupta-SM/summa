// =============================================================================
// MYSQL DIALECT
// =============================================================================
// Implements SqlDialect for MySQL 8.0+.

import type { SqlDialect } from "../dialect.js";

export const mysqlDialect: SqlDialect = {
	name: "mysql",

	advisoryLock(key: number): string {
		// MySQL named locks — session-scoped, must be released manually or on disconnect.
		// Use a negative timeout (0) to fail immediately if lock is held.
		return `SELECT GET_LOCK('summa_${key}', 10)`;
	},

	forUpdate(): string {
		return "FOR UPDATE";
	},

	forUpdateSkipLocked(): string {
		return "FOR UPDATE SKIP LOCKED";
	},

	generateUuid(): string {
		return "UUID()";
	},

	onConflictDoNothing(conflictColumns: string[]): string {
		// MySQL uses ON DUPLICATE KEY syntax; to do nothing we update a column to itself
		const col = conflictColumns[0] ?? "id";
		return `ON DUPLICATE KEY UPDATE ${col} = ${col}`;
	},

	onConflictDoUpdate(conflictColumns: string[], updates: Record<string, string>): string {
		void conflictColumns; // MySQL infers conflict from unique key
		const setClauses = Object.entries(updates)
			.map(([col, expr]) => `${col} = ${expr}`)
			.join(", ");
		return `ON DUPLICATE KEY UPDATE ${setClauses}`;
	},

	returning(_columns: string[]): string {
		// MySQL does not support RETURNING. Callers must use LAST_INSERT_ID() or re-query.
		return "";
	},

	now(): string {
		return "NOW()";
	},

	interval(value: string): string {
		if (!/^\d+\s+[a-z]+$/i.test(value)) {
			throw new Error(`Invalid interval value: "${value}"`);
		}
		return `INTERVAL ${value}`;
	},

	countAsInt(): string {
		// MySQL COUNT(*) returns BIGINT — cast to unsigned for safe integer range
		return "CAST(COUNT(*) AS UNSIGNED)";
	},

	paramPlaceholder(_index: number): string {
		return "?";
	},

	setStatementTimeout(_ms: number): string {
		// MySQL uses MAX_EXECUTION_TIME hint instead of SET — not directly equivalent
		return "";
	},

	setLockTimeout(ms: number): string {
		// innodb_lock_wait_timeout is in seconds
		const seconds = Math.max(1, Math.ceil(ms / 1000));
		return `SET innodb_lock_wait_timeout = ${seconds}`;
	},
};
