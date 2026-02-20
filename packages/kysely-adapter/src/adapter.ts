// =============================================================================
// KYSELY ADAPTER — SummaAdapter implementation backed by Kysely
// =============================================================================
// Uses raw SQL via Kysely's `sql` template for all operations.
// This gives full control over locking, RETURNING, parameterized queries,
// and avoids the complexity of dynamically mapping Where[] to Kysely's
// type-safe query builder across many tables.

import type { SortBy, SummaAdapter, SummaTransactionAdapter, Where } from "@summa/core/db";
import type { Kysely, Transaction } from "kysely";
import { sql } from "kysely";

// =============================================================================
// INTERNAL HELPERS
// =============================================================================

/**
 * Convert a camelCase field name to snake_case for PostgreSQL column names.
 */
function toSnakeCase(str: string): string {
	return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/**
 * Convert a snake_case column name to camelCase for returning data.
 */
function toCamelCase(str: string): string {
	return str.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

/**
 * Convert all keys in a record from camelCase to snake_case.
 */
function keysToSnake(obj: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(obj)) {
		result[toSnakeCase(key)] = value;
	}
	return result;
}

/**
 * Convert all keys in a record from snake_case to camelCase.
 */
function keysToCamel(obj: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(obj)) {
		result[toCamelCase(key)] = value;
	}
	return result;
}

/**
 * Build a SQL WHERE clause from an array of Where conditions.
 * Returns the clause string (without the WHERE keyword) and parameter values.
 * Parameter numbering starts at startIndex (for $1, $2, etc.).
 */
function buildWhereClause(
	where: Where[],
	startIndex: number = 1,
): { clause: string; params: unknown[] } {
	if (where.length === 0) {
		return { clause: "TRUE", params: [] };
	}

	const conditions: string[] = [];
	const params: unknown[] = [];
	let paramIdx = startIndex;

	for (const w of where) {
		const col = toSnakeCase(w.field);

		switch (w.operator) {
			case "eq":
				conditions.push(`"${col}" = $${paramIdx}`);
				params.push(w.value);
				paramIdx++;
				break;
			case "ne":
				conditions.push(`"${col}" != $${paramIdx}`);
				params.push(w.value);
				paramIdx++;
				break;
			case "gt":
				conditions.push(`"${col}" > $${paramIdx}`);
				params.push(w.value);
				paramIdx++;
				break;
			case "gte":
				conditions.push(`"${col}" >= $${paramIdx}`);
				params.push(w.value);
				paramIdx++;
				break;
			case "lt":
				conditions.push(`"${col}" < $${paramIdx}`);
				params.push(w.value);
				paramIdx++;
				break;
			case "lte":
				conditions.push(`"${col}" <= $${paramIdx}`);
				params.push(w.value);
				paramIdx++;
				break;
			case "in": {
				const values = w.value as unknown[];
				const placeholders = values.map((_, i) => `$${paramIdx + i}`).join(", ");
				conditions.push(`"${col}" IN (${placeholders})`);
				params.push(...values);
				paramIdx += values.length;
				break;
			}
			case "like":
				conditions.push(`"${col}" LIKE $${paramIdx}`);
				params.push(w.value);
				paramIdx++;
				break;
			case "is_null":
				conditions.push(`"${col}" IS NULL`);
				break;
			case "is_not_null":
				conditions.push(`"${col}" IS NOT NULL`);
				break;
		}
	}

	return { clause: conditions.join(" AND "), params };
}

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
// ADAPTER METHODS BUILDER
// =============================================================================

/**
 * Build the core adapter methods for a given Kysely database or transaction handle.
 */
function buildAdapterMethods(
	db: Kysely<any> | Transaction<any>,
): Omit<SummaTransactionAdapter, "id" | "options"> {
	return {
		create: async <T extends Record<string, unknown>>({
			model,
			data,
		}: {
			model: string;
			data: T;
		}): Promise<T> => {
			const snakeData = keysToSnake(data as Record<string, unknown>);
			const columns = Object.keys(snakeData);
			const values = Object.values(snakeData);

			if (columns.length === 0) {
				throw new Error(`Cannot insert empty data into ${model}`);
			}

			const columnList = columns.map((c) => `"${c}"`).join(", ");
			const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
			const query = `INSERT INTO "${model}" (${columnList}) VALUES (${placeholders}) RETURNING *`;

			const result = await buildKyselySql(query, values).execute(db);
			const rows = (result as { rows: Record<string, unknown>[] }).rows ?? [];
			const row = rows[0];
			if (!row) {
				throw new Error(`Insert into ${model} returned no rows`);
			}
			return keysToCamel(row) as T;
		},

		findOne: async <T>({
			model,
			where,
			forUpdate,
		}: {
			model: string;
			where: Where[];
			forUpdate?: boolean;
		}): Promise<T | null> => {
			const { clause, params } = buildWhereClause(where);
			let query = `SELECT * FROM "${model}" WHERE ${clause} LIMIT 1`;
			if (forUpdate) {
				query += " FOR UPDATE";
			}

			const result = await buildKyselySql(query, params).execute(db);
			const rows = (result as { rows: Record<string, unknown>[] }).rows ?? [];
			const row = rows[0];
			if (!row) return null;
			return keysToCamel(row) as T;
		},

		findMany: async <T>({
			model,
			where,
			limit,
			offset,
			sortBy,
		}: {
			model: string;
			where?: Where[];
			limit?: number;
			offset?: number;
			sortBy?: SortBy;
		}): Promise<T[]> => {
			const { clause, params } = buildWhereClause(where ?? []);
			let query = `SELECT * FROM "${model}" WHERE ${clause}`;
			let paramIdx = params.length + 1;

			if (sortBy) {
				const col = toSnakeCase(sortBy.field);
				const dir = sortBy.direction === "desc" ? "DESC" : "ASC";
				query += ` ORDER BY "${col}" ${dir}`;
			}

			if (limit !== undefined) {
				query += ` LIMIT $${paramIdx}`;
				params.push(limit);
				paramIdx++;
			}

			if (offset !== undefined) {
				query += ` OFFSET $${paramIdx}`;
				params.push(offset);
				paramIdx++;
			}

			const result = await buildKyselySql(query, params).execute(db);
			const rows = (result as { rows: Record<string, unknown>[] }).rows ?? [];
			return rows.map((r) => keysToCamel(r) as T);
		},

		update: async <T>({
			model,
			where,
			update: updateData,
		}: {
			model: string;
			where: Where[];
			update: Record<string, unknown>;
		}): Promise<T | null> => {
			const snakeData = keysToSnake(updateData);
			const setCols = Object.keys(snakeData);
			const setValues = Object.values(snakeData);

			if (setCols.length === 0) {
				throw new Error(`Cannot update ${model} with empty data`);
			}

			const setClause = setCols.map((c, i) => `"${c}" = $${i + 1}`).join(", ");
			const { clause: whereClause, params: whereParams } = buildWhereClause(
				where,
				setCols.length + 1,
			);

			const allParams = [...setValues, ...whereParams];
			const query = `UPDATE "${model}" SET ${setClause} WHERE ${whereClause} RETURNING *`;

			const result = await buildKyselySql(query, allParams).execute(db);
			const rows = (result as { rows: Record<string, unknown>[] }).rows ?? [];
			const row = rows[0];
			if (!row) return null;
			return keysToCamel(row) as T;
		},

		delete: async ({ model, where }: { model: string; where: Where[] }): Promise<void> => {
			const { clause, params } = buildWhereClause(where);
			const query = `DELETE FROM "${model}" WHERE ${clause}`;
			await buildKyselySql(query, params).execute(db);
		},

		count: async ({ model, where }: { model: string; where?: Where[] }): Promise<number> => {
			const { clause, params } = buildWhereClause(where ?? []);
			const query = `SELECT COUNT(*)::int AS count FROM "${model}" WHERE ${clause}`;

			const result = await buildKyselySql(query, params).execute(db);
			const rows = (result as { rows: { count: number }[] }).rows ?? [];
			const row = rows[0];
			return row?.count ?? 0;
		},

		advisoryLock: async (key: number): Promise<void> => {
			await sql`SELECT pg_advisory_xact_lock(${key})`.execute(db);
		},

		raw: async <T>(sqlStr: string, params: unknown[]): Promise<T[]> => {
			const result = await buildKyselySql(sqlStr, params).execute(db);
			const rows = (result as { rows: T[] }).rows ?? [];
			return rows;
		},

		rawMutate: async (sqlStr: string, params: unknown[]): Promise<number> => {
			const result = await buildKyselySql(sqlStr, params).execute(db);
			// Kysely returns numAffectedRows as a bigint on the result for mutation queries
			const numAffected = (result as { numAffectedRows?: bigint }).numAffectedRows;
			if (numAffected !== undefined) {
				return Number(numAffected);
			}
			return 0;
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
 * import { kyselyAdapter } from "@summa/kysely-adapter";
 *
 * const db = new Kysely({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: process.env.DATABASE_URL }) }) });
 * const adapter = kyselyAdapter(db);
 * ```
 */
// biome-ignore lint/suspicious/noExplicitAny: Kysely generic type varies by schema
export function kyselyAdapter(db: Kysely<any>): SummaAdapter {
	const methods = buildAdapterMethods(db);

	return {
		id: "kysely",
		...methods,

		transaction: async <T>(fn: (tx: SummaTransactionAdapter) => Promise<T>): Promise<T> => {
			return db.transaction().execute(async (tx) => {
				const txMethods = buildAdapterMethods(tx);
				const txAdapter: SummaTransactionAdapter = {
					id: "kysely",
					...txMethods,
					options: {
						supportsAdvisoryLocks: true,
						supportsForUpdate: true,
						supportsReturning: true,
						dialectName: "postgres",
					},
				};
				return fn(txAdapter);
			});
		},

		options: {
			supportsAdvisoryLocks: true,
			supportsForUpdate: true,
			supportsReturning: true,
			dialectName: "postgres",
		},
	};
}
