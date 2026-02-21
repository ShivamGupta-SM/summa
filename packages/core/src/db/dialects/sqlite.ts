// =============================================================================
// SQLITE DIALECT
// =============================================================================
// Implements SqlDialect for SQLite 3.35+ (with RETURNING support).
// Suitable for local development, prototyping, and edge deployments.

import type { SqlDialect } from "../dialect.js";

export const sqliteDialect: SqlDialect = {
	name: "sqlite",

	advisoryLock(_key: number): string {
		// SQLite has no advisory locks. Entire DB locks on write via WAL journal.
		// Callers should use BEGIN EXCLUSIVE for critical sections.
		return "";
	},

	forUpdate(): string {
		// SQLite has no row-level locking — the entire database locks on write.
		return "";
	},

	forUpdateSkipLocked(): string {
		return "";
	},

	generateUuid(): string {
		// SQLite has no native UUID. Use hex(randomblob(16)) as a fallback.
		return "lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6)))";
	},

	onConflictDoNothing(conflictColumns: string[]): string {
		return `ON CONFLICT (${conflictColumns.join(", ")}) DO NOTHING`;
	},

	onConflictDoUpdate(conflictColumns: string[], updates: Record<string, string>): string {
		const setClauses = Object.entries(updates)
			.map(([col, expr]) => `${col} = ${expr}`)
			.join(", ");
		return `ON CONFLICT (${conflictColumns.join(", ")}) DO UPDATE SET ${setClauses}`;
	},

	returning(columns: string[]): string {
		// SQLite 3.35+ supports RETURNING
		return `RETURNING ${columns.join(", ")}`;
	},

	now(): string {
		// ISO 8601 string
		return "datetime('now')";
	},

	interval(value: string): string {
		if (!/^\d+\s+[a-z]+$/i.test(value)) {
			throw new Error(`Invalid interval value: "${value}"`);
		}
		// SQLite uses datetime() modifiers: datetime('now', '+5 minutes')
		// Return the modifier string — callers must use datetime(col, modifier)
		return `'+${value}'`;
	},

	countAsInt(): string {
		// SQLite COUNT(*) returns integer natively
		return "COUNT(*)";
	},

	paramPlaceholder(_index: number): string {
		return "?";
	},

	setStatementTimeout(_ms: number): string {
		// SQLite has no statement timeout — use busy_timeout instead
		return "";
	},

	setLockTimeout(ms: number): string {
		// PRAGMA busy_timeout controls how long to wait for a lock
		return `PRAGMA busy_timeout = ${ms}`;
	},
};
