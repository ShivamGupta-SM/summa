// =============================================================================
// POSTGRESQL DIALECT
// =============================================================================
// Implements SqlDialect for PostgreSQL 14+.

import type { SqlDialect } from "../dialect.js";

export const postgresDialect: SqlDialect = {
	name: "postgres",

	advisoryLock(key: number): string {
		return `SELECT pg_advisory_xact_lock(${key})`;
	},

	forUpdate(): string {
		return "FOR UPDATE";
	},

	forUpdateSkipLocked(): string {
		return "FOR UPDATE SKIP LOCKED";
	},

	generateUuid(): string {
		return "gen_random_uuid()";
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
		return `RETURNING ${columns.join(", ")}`;
	},

	now(): string {
		return "NOW()";
	},

	interval(value: string): string {
		// Validate interval to prevent SQL injection — only allow safe patterns like "1 day", "30 minutes"
		if (!/^\d+\s+[a-z]+$/i.test(value)) {
			throw new Error(`Invalid interval value: "${value}"`);
		}
		return `INTERVAL '${value}'`;
	},

	countAsInt(): string {
		return "COUNT(*)::int";
	},

	paramPlaceholder(index: number): string {
		return `$${index}`;
	},

	setStatementTimeout(ms: number): string {
		return `SET statement_timeout = ${ms}`;
	},

	setLockTimeout(ms: number): string {
		return `SET lock_timeout = ${ms}`;
	},
};
