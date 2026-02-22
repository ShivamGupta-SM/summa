// =============================================================================
// DRIZZLE ADAPTER — SummaAdapter implementation backed by Drizzle ORM
// =============================================================================
// Uses raw SQL via drizzle-orm's `sql` template for all operations.
// CRUD logic is shared via buildSqlAdapterMethods from @summa-ledger/core/db.

import {
	buildSqlAdapterMethods,
	postgresDialect,
	type SqlExecutor,
	type SummaAdapter,
	type SummaAdapterOptions,
	type SummaTransactionAdapter,
} from "@summa-ledger/core/db";
import { type SQL, sql } from "drizzle-orm";

/**
 * Build SQL string with embedded parameter values using drizzle's sql template.
 * This converts $1, $2 style placeholders + params into a drizzle sql`` tagged template.
 */
function buildDrizzleSql(query: string, params: unknown[]) {
	// If no params, return raw SQL directly
	if (params.length === 0) {
		return sql.raw(query);
	}

	// Split the query by $N placeholders and interleave with params
	const chunks: SQL[] = [];
	let lastIdx = 0;
	const regex = /\$(\d+)/g;
	let match: RegExpExecArray | null = regex.exec(query);

	while (match !== null) {
		// Add the raw SQL before this placeholder
		if (match.index > lastIdx) {
			chunks.push(sql.raw(query.slice(lastIdx, match.index)));
		}
		// Add the parameterized value
		const paramIndex = parseInt(match[1]!, 10) - 1;
		chunks.push(sql`${params[paramIndex]}`);
		lastIdx = match.index + match[0].length;
		match = regex.exec(query);
	}

	// Add remaining SQL after the last placeholder
	if (lastIdx < query.length) {
		chunks.push(sql.raw(query.slice(lastIdx)));
	}

	if (chunks.length === 0) {
		return sql.raw(query);
	}

	// Use sql.join with empty separator to avoid nested template issues
	return sql.join(chunks, sql.raw(""));
}

// =============================================================================
// SQL EXECUTOR — Drizzle-specific query execution
// =============================================================================

// biome-ignore lint/suspicious/noExplicitAny: Drizzle db/tx type varies by driver
function createDrizzleExecutor(db: any): SqlExecutor {
	return {
		query: async <T>(sqlStr: string, params: unknown[]): Promise<T[]> => {
			const result = await db.execute(buildDrizzleSql(sqlStr, params));
			const rows = Array.isArray(result) ? result : (result.rows ?? []);
			return rows as T[];
		},
		mutate: async (sqlStr: string, params: unknown[]): Promise<number> => {
			const result = await db.execute(buildDrizzleSql(sqlStr, params));
			if (typeof result === "object" && result !== null && "rowCount" in result) {
				return (result as { rowCount: number }).rowCount ?? 0;
			}
			if (Array.isArray(result)) {
				return result.length;
			}
			return 0;
		},
		advisoryLock: async (key: number): Promise<void> => {
			await db.execute(sql`SELECT pg_advisory_xact_lock(${key})`);
		},
	};
}

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Create a SummaAdapter backed by a Drizzle ORM database instance.
 *
 * @param db - A Drizzle database instance (e.g., from `drizzle(pool)`)
 * @returns A SummaAdapter implementation
 *
 * @example
 * ```ts
 * import { drizzle } from "drizzle-orm/node-postgres";
 * import { Pool } from "pg";
 * import { drizzleAdapter } from "@summa-ledger/drizzle-adapter";
 *
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 * const db = drizzle(pool);
 * const adapter = drizzleAdapter(db);
 * ```
 */
// biome-ignore lint/suspicious/noExplicitAny: Drizzle db type varies by driver
export function drizzleAdapter(db: any): SummaAdapter {
	// Shared mutable options — schema is set later by buildContext()
	const sharedOptions: SummaAdapterOptions = {
		supportsAdvisoryLocks: true,
		supportsForUpdate: true,
		supportsReturning: true,
		dialectName: "postgres",
		dialect: postgresDialect,
	};

	const executor = createDrizzleExecutor(db);
	const methods = buildSqlAdapterMethods(executor, () => sharedOptions.schema ?? "summa");

	return {
		id: "drizzle",
		...methods,

		transaction: async <T>(fn: (tx: SummaTransactionAdapter) => Promise<T>): Promise<T> => {
			// biome-ignore lint/suspicious/noExplicitAny: Drizzle transaction type varies by driver
			return db.transaction(async (tx: any) => {
				const txExecutor = createDrizzleExecutor(tx);
				const txMethods = buildSqlAdapterMethods(txExecutor, () => sharedOptions.schema ?? "summa");
				const txAdapter: SummaTransactionAdapter = {
					id: "drizzle",
					...txMethods,
					options: sharedOptions,
				};
				return fn(txAdapter);
			});
		},

		options: sharedOptions,
	};
}
