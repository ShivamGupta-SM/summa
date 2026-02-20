// =============================================================================
// DRIZZLE ADAPTER — SummaAdapter implementation backed by Drizzle ORM
// =============================================================================
// Uses raw SQL via drizzle-orm's `sql` template for all operations.
// This gives full control over locking, RETURNING, parameterized queries,
// and avoids the complexity of dynamically mapping Where[] to Drizzle's
// type-safe column API across 20+ tables.

import {
	buildWhereClause,
	keysToCamel,
	keysToSnake,
	postgresDialect,
	type SortBy,
	type SummaAdapter,
	type SummaTransactionAdapter,
	toSnakeCase,
	type Where,
} from "@summa/core/db";
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
// ADAPTER FACTORY — creates a SummaAdapter or SummaTransactionAdapter
// =============================================================================

/**
 * Build the core adapter methods for a given Drizzle database or transaction handle.
 */
// biome-ignore lint/suspicious/noExplicitAny: Drizzle db/tx type varies by driver
function buildAdapterMethods(db: any): Omit<SummaTransactionAdapter, "id" | "options"> {
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

			const result = await db.execute(buildDrizzleSql(query, values));
			const rows = Array.isArray(result) ? result : (result.rows ?? []);
			const row = rows[0];
			if (!row) {
				throw new Error(`Insert into ${model} returned no rows`);
			}
			return keysToCamel(row as Record<string, unknown>) as T;
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

			const result = await db.execute(buildDrizzleSql(query, params));
			const rows = Array.isArray(result) ? result : (result.rows ?? []);
			const row = rows[0];
			if (!row) return null;
			return keysToCamel(row as Record<string, unknown>) as T;
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

			const result = await db.execute(buildDrizzleSql(query, params));
			const rows = Array.isArray(result) ? result : (result.rows ?? []);
			return (rows as Record<string, unknown>[]).map((r) => keysToCamel(r) as T);
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

			const result = await db.execute(buildDrizzleSql(query, allParams));
			const rows = Array.isArray(result) ? result : (result.rows ?? []);
			const row = rows[0];
			if (!row) return null;
			return keysToCamel(row as Record<string, unknown>) as T;
		},

		delete: async ({ model, where }: { model: string; where: Where[] }): Promise<void> => {
			const { clause, params } = buildWhereClause(where);
			const query = `DELETE FROM "${model}" WHERE ${clause}`;
			await db.execute(buildDrizzleSql(query, params));
		},

		count: async ({ model, where }: { model: string; where?: Where[] }): Promise<number> => {
			const { clause, params } = buildWhereClause(where ?? []);
			const query = `SELECT COUNT(*)::int AS count FROM "${model}" WHERE ${clause}`;

			const result = await db.execute(buildDrizzleSql(query, params));
			const rows = Array.isArray(result) ? result : (result.rows ?? []);
			const row = rows[0] as { count: number } | undefined;
			return row?.count ?? 0;
		},

		advisoryLock: async (key: number): Promise<void> => {
			await db.execute(sql`SELECT pg_advisory_xact_lock(${key})`);
		},

		raw: async <T>(sqlStr: string, params: unknown[]): Promise<T[]> => {
			const result = await db.execute(buildDrizzleSql(sqlStr, params));
			const rows = Array.isArray(result) ? result : (result.rows ?? []);
			return rows as T[];
		},

		rawMutate: async (sqlStr: string, params: unknown[]): Promise<number> => {
			const result = await db.execute(buildDrizzleSql(sqlStr, params));
			// Drizzle returns rowCount on the result for mutation queries
			if (typeof result === "object" && result !== null && "rowCount" in result) {
				return (result as { rowCount: number }).rowCount ?? 0;
			}
			// For array results (node-postgres via drizzle), check length
			if (Array.isArray(result)) {
				return result.length;
			}
			return 0;
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
 * import { drizzleAdapter } from "@summa/drizzle-adapter";
 *
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 * const db = drizzle(pool);
 * const adapter = drizzleAdapter(db);
 * ```
 */
// biome-ignore lint/suspicious/noExplicitAny: Drizzle db type varies by driver
export function drizzleAdapter(db: any): SummaAdapter {
	const methods = buildAdapterMethods(db);

	return {
		id: "drizzle",
		...methods,

		transaction: async <T>(fn: (tx: SummaTransactionAdapter) => Promise<T>): Promise<T> => {
			// biome-ignore lint/suspicious/noExplicitAny: Drizzle transaction type varies by driver
			return db.transaction(async (tx: any) => {
				const txMethods = buildAdapterMethods(tx);
				const txAdapter: SummaTransactionAdapter = {
					id: "drizzle",
					...txMethods,
					options: {
						supportsAdvisoryLocks: true,
						supportsForUpdate: true,
						supportsReturning: true,
						dialectName: "postgres",
						dialect: postgresDialect,
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
			dialect: postgresDialect,
		},
	};
}
