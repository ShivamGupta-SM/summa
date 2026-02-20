// =============================================================================
// PRISMA ADAPTER — SummaAdapter implementation backed by Prisma Client
// =============================================================================
// Uses raw SQL via Prisma's $queryRawUnsafe / $executeRawUnsafe for all operations.
// This gives full control over locking, RETURNING, parameterized queries,
// and avoids the complexity of dynamically mapping Where[] to Prisma's
// type-safe model API across many tables.

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
