// =============================================================================
// SQL ADAPTER METHODS — Shared CRUD logic for all SQL-based adapters
// =============================================================================
// All SQL adapters (Drizzle, Prisma, Kysely) build identical SQL for CRUD
// operations. The only difference is how each ORM executes the query.
// This module extracts the shared logic so each adapter only needs to
// implement a 3-method SqlExecutor interface.

import type { SortBy, SummaTransactionAdapter, Where } from "./adapter.js";
import { buildWhereClause, keysToCamel, keysToSnake, toSnakeCase } from "./adapter-utils.js";
import { createTableResolver } from "./schema-prefix.js";

// =============================================================================
// SQL EXECUTOR INTERFACE
// =============================================================================

/**
 * Minimal interface that each ORM adapter must implement.
 * All CRUD logic is built on top of these three methods.
 */
export interface SqlExecutor {
	/** Execute a SELECT query and return rows. */
	query<T = Record<string, unknown>>(sql: string, params: unknown[]): Promise<T[]>;
	/** Execute an INSERT/UPDATE/DELETE and return affected row count. */
	mutate(sql: string, params: unknown[]): Promise<number>;
	/** Acquire a PostgreSQL advisory lock. */
	advisoryLock(key: number): Promise<void>;
}

// =============================================================================
// SHARED CRUD BUILDER
// =============================================================================

/**
 * Build the standard adapter methods from a SqlExecutor.
 * Returns everything needed for a SummaTransactionAdapter except `id` and `options`.
 */
export function buildSqlAdapterMethods(
	executor: SqlExecutor,
	getSchema: () => string,
): Omit<SummaTransactionAdapter, "id" | "options"> {
	return {
		create: async <T extends Record<string, unknown>>({
			model,
			data,
		}: {
			model: string;
			data: T;
		}): Promise<T> => {
			const t = createTableResolver(getSchema());
			const snakeData = keysToSnake(data as Record<string, unknown>);
			const columns = Object.keys(snakeData);
			const values = Object.values(snakeData);

			if (columns.length === 0) {
				throw new Error(`Cannot insert empty data into ${model}`);
			}

			const columnList = columns.map((c) => `"${c}"`).join(", ");
			const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
			const query = `INSERT INTO ${t(model)} (${columnList}) VALUES (${placeholders}) RETURNING *`;

			const rows = await executor.query(query, values);
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
			const t = createTableResolver(getSchema());
			const { clause, params } = buildWhereClause(where);
			let query = `SELECT * FROM ${t(model)} WHERE ${clause} LIMIT 1`;
			if (forUpdate) {
				query += " FOR UPDATE";
			}

			const rows = await executor.query(query, params);
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
			const t = createTableResolver(getSchema());
			const { clause, params } = buildWhereClause(where ?? []);
			let query = `SELECT * FROM ${t(model)} WHERE ${clause}`;
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

			const rows = await executor.query(query, params);
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

			const t = createTableResolver(getSchema());
			const allParams = [...setValues, ...whereParams];
			const query = `UPDATE ${t(model)} SET ${setClause} WHERE ${whereClause} RETURNING *`;

			const rows = await executor.query(query, allParams);
			const row = rows[0];
			if (!row) return null;
			return keysToCamel(row as Record<string, unknown>) as T;
		},

		delete: async ({ model, where }: { model: string; where: Where[] }): Promise<void> => {
			const t = createTableResolver(getSchema());
			const { clause, params } = buildWhereClause(where);
			const query = `DELETE FROM ${t(model)} WHERE ${clause}`;
			await executor.mutate(query, params);
		},

		count: async ({ model, where }: { model: string; where?: Where[] }): Promise<number> => {
			const t = createTableResolver(getSchema());
			const { clause, params } = buildWhereClause(where ?? []);
			const query = `SELECT COUNT(*)::int AS count FROM ${t(model)} WHERE ${clause}`;

			const rows = await executor.query<{ count: number }>(query, params);
			const row = rows[0];
			return row?.count ?? 0;
		},

		advisoryLock: executor.advisoryLock.bind(executor),

		raw: async <T>(sqlStr: string, params: unknown[]): Promise<T[]> => {
			return executor.query<T>(sqlStr, params);
		},

		rawMutate: async (sqlStr: string, params: unknown[]): Promise<number> => {
			return executor.mutate(sqlStr, params);
		},
	};
}
