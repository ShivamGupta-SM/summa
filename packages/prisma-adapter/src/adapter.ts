// =============================================================================
// PRISMA ADAPTER — SummaAdapter implementation backed by Prisma Client
// =============================================================================
// Uses raw SQL via Prisma's $queryRawUnsafe / $executeRawUnsafe for all operations.
// CRUD logic is shared via buildSqlAdapterMethods from @summa-ledger/core/db.

import {
	buildSqlAdapterMethods,
	postgresDialect,
	type SqlExecutor,
	type SummaAdapter,
	type SummaAdapterOptions,
	type SummaTransactionAdapter,
} from "@summa-ledger/core/db";

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
// SQL EXECUTOR — Prisma-specific query execution
// =============================================================================

function createPrismaExecutor(client: PrismaClientLike | PrismaTransactionClient): SqlExecutor {
	return {
		query: async <T>(sql: string, params: unknown[]): Promise<T[]> => {
			return client.$queryRawUnsafe<T[]>(sql, ...params);
		},
		mutate: async (sql: string, params: unknown[]): Promise<number> => {
			return client.$executeRawUnsafe(sql, ...params);
		},
		advisoryLock: async (key: number): Promise<void> => {
			await client.$queryRawUnsafe("SELECT pg_advisory_xact_lock($1)", key);
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
 * import { prismaAdapter } from "@summa-ledger/prisma-adapter";
 *
 * const prisma = new PrismaClient();
 * const adapter = prismaAdapter(prisma);
 * ```
 */
export function prismaAdapter(prisma: PrismaClientLike): SummaAdapter {
	// Shared mutable options — schema is set later by buildContext()
	const sharedOptions: SummaAdapterOptions = {
		supportsAdvisoryLocks: true,
		supportsForUpdate: true,
		supportsReturning: true,
		dialectName: "postgres",
		dialect: postgresDialect,
	};

	const executor = createPrismaExecutor(prisma);
	const methods = buildSqlAdapterMethods(executor, () => sharedOptions.schema ?? "summa");

	return {
		id: "prisma",
		...methods,

		transaction: async <T>(fn: (tx: SummaTransactionAdapter) => Promise<T>): Promise<T> => {
			return prisma.$transaction(async (tx) => {
				const txExecutor = createPrismaExecutor(tx);
				const txMethods = buildSqlAdapterMethods(txExecutor, () => sharedOptions.schema ?? "summa");
				const txAdapter: SummaTransactionAdapter = {
					id: "prisma",
					...txMethods,
					options: sharedOptions,
				};
				return fn(txAdapter);
			});
		},

		options: sharedOptions,
	};
}
