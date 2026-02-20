// =============================================================================
// PRISMA ADAPTER — SummaAdapter implementation backed by Prisma Client
// =============================================================================
// Uses raw SQL via Prisma's $queryRawUnsafe / $executeRawUnsafe for all operations.
// This gives full control over locking, RETURNING, parameterized queries,
// and avoids the complexity of dynamically mapping Where[] to Prisma's
// type-safe model API across many tables.

import type { SortBy, SummaAdapter, SummaTransactionAdapter, Where } from "@summa/core/db";

// =============================================================================
// TYPES
// =============================================================================

/**
 * Minimal PrismaClient interface — only the raw query methods we need.
 * This avoids requiring the full generated PrismaClient type.
 */
interface PrismaClientLike {
	$queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
	$executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
	$transaction<T>(fn: (tx: PrismaTransactionClient) => Promise<T>): Promise<T>;
}

interface PrismaTransactionClient {
	$queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
	$executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

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

// =============================================================================
// ADAPTER METHODS BUILDER
// =============================================================================

/**
 * Build the core adapter methods for a given Prisma client or transaction handle.
 */
function buildAdapterMethods(
	client: PrismaClientLike | PrismaTransactionClient,
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

			const rows = await client.$queryRawUnsafe<Record<string, unknown>[]>(query, ...values);
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

			const rows = await client.$queryRawUnsafe<Record<string, unknown>[]>(query, ...params);
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

			const rows = await client.$queryRawUnsafe<Record<string, unknown>[]>(query, ...params);
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

			const rows = await client.$queryRawUnsafe<Record<string, unknown>[]>(query, ...allParams);
			const row = rows[0];
			if (!row) return null;
			return keysToCamel(row) as T;
		},

		delete: async ({ model, where }: { model: string; where: Where[] }): Promise<void> => {
			const { clause, params } = buildWhereClause(where);
			const query = `DELETE FROM "${model}" WHERE ${clause}`;
			await client.$executeRawUnsafe(query, ...params);
		},

		count: async ({ model, where }: { model: string; where?: Where[] }): Promise<number> => {
			const { clause, params } = buildWhereClause(where ?? []);
			const query = `SELECT COUNT(*)::int AS count FROM "${model}" WHERE ${clause}`;

			const rows = await client.$queryRawUnsafe<{ count: number }[]>(query, ...params);
			const row = rows[0];
			return row?.count ?? 0;
		},

		advisoryLock: async (key: number): Promise<void> => {
			await client.$queryRawUnsafe("SELECT pg_advisory_xact_lock($1)", key);
		},

		raw: async <T>(sqlStr: string, params: unknown[]): Promise<T[]> => {
			const rows = await client.$queryRawUnsafe<T[]>(sqlStr, ...params);
			return rows;
		},

		rawMutate: async (sqlStr: string, params: unknown[]): Promise<number> => {
			const count = await client.$executeRawUnsafe(sqlStr, ...params);
			return count;
		},
	};
}

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Create a SummaAdapter backed by a Prisma Client instance.
 *
 * @param prisma - A PrismaClient instance
 * @returns A SummaAdapter implementation
 *
 * @example
 * ```ts
 * import { PrismaClient } from "@prisma/client";
 * import { prismaAdapter } from "@summa/prisma-adapter";
 *
 * const prisma = new PrismaClient();
 * const adapter = prismaAdapter(prisma);
 * ```
 */
export function prismaAdapter(prisma: PrismaClientLike): SummaAdapter {
	const methods = buildAdapterMethods(prisma);

	return {
		id: "prisma",
		...methods,

		transaction: async <T>(fn: (tx: SummaTransactionAdapter) => Promise<T>): Promise<T> => {
			return prisma.$transaction(async (tx) => {
				const txMethods = buildAdapterMethods(tx as PrismaTransactionClient);
				const txAdapter: SummaTransactionAdapter = {
					id: "prisma",
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
