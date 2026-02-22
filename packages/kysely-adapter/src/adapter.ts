// =============================================================================
// KYSELY ADAPTER — SummaAdapter implementation backed by Kysely
// =============================================================================
// Uses raw SQL via Kysely's `sql` template for all operations.
// CRUD logic is shared via buildSqlAdapterMethods from @summa-ledger/core/db.

import type {
	SummaAdapter,
	SummaAdapterOptions,
	SummaTransactionAdapter,
} from "@summa-ledger/core/db";
import { buildSqlAdapterMethods, postgresDialect, type SqlExecutor } from "@summa-ledger/core/sql";
import type { Kysely, Transaction } from "kysely";
import { sql } from "kysely";

/**
 * Build a Kysely sql template from a raw query string with $N placeholders and params.
 * Converts $1, $2 style placeholders + params into a Kysely sql`` tagged template.
 */
function buildKyselySql(query: string, params: unknown[]) {
	const chunks: ReturnType<typeof sql.raw>[] = [];
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

	// Join all chunks into a single sql template
	if (chunks.length === 0) {
		return sql.raw(query);
	}

	return chunks.reduce((acc, chunk) => sql`${acc}${chunk}`);
}

// =============================================================================
// SQL EXECUTOR — Kysely-specific query execution
// =============================================================================

// biome-ignore lint/suspicious/noExplicitAny: Kysely generic type varies by schema
function createKyselyExecutor(db: Kysely<any> | Transaction<any>): SqlExecutor {
	return {
		query: async <T>(sqlStr: string, params: unknown[]): Promise<T[]> => {
			const result = await buildKyselySql(sqlStr, params).execute(db);
			const rows = (result as { rows: T[] }).rows ?? [];
			return rows;
		},
		mutate: async (sqlStr: string, params: unknown[]): Promise<number> => {
			const result = await buildKyselySql(sqlStr, params).execute(db);
			const numAffected = (result as { numAffectedRows?: bigint }).numAffectedRows;
			if (numAffected !== undefined) {
				return Number(numAffected);
			}
			return 0;
		},
		advisoryLock: async (key: number): Promise<void> => {
			await sql`SELECT pg_advisory_xact_lock(${key})`.execute(db);
		},
	};
}

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Create a SummaAdapter backed by a Kysely database instance.
 *
 * @param db - A Kysely database instance
 * @returns A SummaAdapter implementation
 *
 * @example
 * ```ts
 * import { Kysely, PostgresDialect } from "kysely";
 * import { Pool } from "pg";
 * import { kyselyAdapter } from "@summa-ledger/kysely-adapter";
 *
 * const db = new Kysely({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: process.env.DATABASE_URL }) }) });
 * const adapter = kyselyAdapter(db);
 * ```
 */
// biome-ignore lint/suspicious/noExplicitAny: Kysely generic type varies by schema
export function kyselyAdapter(db: Kysely<any>): SummaAdapter {
	// Shared mutable options — schema is set later by buildContext()
	const sharedOptions: SummaAdapterOptions = {
		supportsAdvisoryLocks: true,
		supportsForUpdate: true,
		supportsReturning: true,
		dialectName: "postgres",
		dialect: postgresDialect,
	};

	const executor = createKyselyExecutor(db);
	const methods = buildSqlAdapterMethods(executor, () => sharedOptions.schema ?? "summa");

	return {
		id: "kysely",
		...methods,

		transaction: async <T>(fn: (tx: SummaTransactionAdapter) => Promise<T>): Promise<T> => {
			return db.transaction().execute(async (tx) => {
				const txExecutor = createKyselyExecutor(tx);
				const txMethods = buildSqlAdapterMethods(txExecutor, () => sharedOptions.schema ?? "summa");
				const txAdapter: SummaTransactionAdapter = {
					id: "kysely",
					...txMethods,
					options: sharedOptions,
				};
				return fn(txAdapter);
			});
		},

		options: sharedOptions,
	};
}
