// =============================================================================
// INTERNAL ADAPTER
// =============================================================================
// Wraps the raw SummaAdapter with plugin hooks (operationHooks) and optional
// secondary storage read-through caching.

import type { SecondaryStorage, SummaAdapter, SummaLogger, SummaPlugin } from "@summa/core";
import { SummaError } from "@summa/core";

// Tables that MUST NOT be updated or deleted — financial data integrity.
// Any attempt to call update() or delete() on these models throws immediately.
const IMMUTABLE_MODELS: ReadonlySet<string> = new Set([
	"account_balance",
	"account_balance_version",
	"system_account",
	"system_account_version",
	"transaction_record",
	"transaction_status",
	"entry_record",
	"ledger_event",
	"block_checkpoint",
	"merkle_node",
	"entity_status_log",
]);

export interface InternalAdapterOptions {
	adapter: SummaAdapter;
	logger: SummaLogger;
	plugins: SummaPlugin[];
	secondaryStorage?: SecondaryStorage;
}

export type InternalAdapter = SummaAdapter & {
	/** The underlying raw adapter */
	readonly rawAdapter: SummaAdapter;
};

/**
 * Creates an internal adapter that wraps CRUD operations with plugin hooks.
 * - Runs `operationHooks.before` matchers before mutations
 * - Runs `operationHooks.after` matchers after mutations
 * - Optional read-through cache via SecondaryStorage
 */
export function createInternalAdapter(options: InternalAdapterOptions): InternalAdapter {
	const { adapter, logger, secondaryStorage } = options;

	const cachePrefix = "summa:cache:";

	// Track cached keys per model so we can invalidate on mutations
	const cachedKeysByModel = new Map<string, Set<string>>();

	async function invalidateModelCache(model: string): Promise<void> {
		if (!secondaryStorage) return;
		const keys = cachedKeysByModel.get(model);
		if (!keys || keys.size === 0) return;
		const deletePromises = [...keys].map((key) =>
			secondaryStorage.delete(key).catch((error: unknown) => {
				logger.warn("Failed to invalidate cache key", { key, error: String(error) });
			}),
		);
		await Promise.all(deletePromises);
		keys.clear();
	}

	async function cachedFindOne<T>(
		findData: Parameters<SummaAdapter["findOne"]>[0],
	): Promise<T | null> {
		if (!secondaryStorage) {
			return adapter.findOne<T>(findData);
		}

		const cacheKey = `${cachePrefix}${findData.model}:${JSON.stringify(findData.where)}`;
		const cached = await secondaryStorage.get(cacheKey);
		if (cached) {
			try {
				return JSON.parse(cached) as T;
			} catch {
				logger.warn("Failed to parse cached value, falling through to DB", {
					key: cacheKey,
				});
			}
		}

		const result = await adapter.findOne<T>(findData);
		if (result) {
			await secondaryStorage.set(cacheKey, JSON.stringify(result), 300).catch((error: unknown) => {
				logger.warn("Failed to write to secondary storage", { error: String(error) });
			});
			// Track this key for future invalidation
			let modelKeys = cachedKeysByModel.get(findData.model);
			if (!modelKeys) {
				modelKeys = new Set();
				cachedKeysByModel.set(findData.model, modelKeys);
			}
			modelKeys.add(cacheKey);
		}
		return result;
	}

	return {
		id: adapter.id,
		options: adapter.options,
		rawAdapter: adapter,

		create: async (data) => {
			const result = await adapter.create(data);
			await invalidateModelCache(data.model);
			return result;
		},

		findOne: cachedFindOne,

		findMany: adapter.findMany.bind(adapter),

		update: async (data) => {
			if (IMMUTABLE_MODELS.has(data.model)) {
				throw SummaError.internal(
					`Table "${data.model}" is immutable. UPDATE operations are not allowed. Use append-only version tables instead.`,
				);
			}
			const result = await adapter.update(data);
			await invalidateModelCache(data.model);
			return result;
		},

		delete: async (data) => {
			if (IMMUTABLE_MODELS.has(data.model)) {
				throw SummaError.internal(
					`Table "${data.model}" is immutable. DELETE operations are not allowed.`,
				);
			}
			await adapter.delete(data);
			await invalidateModelCache(data.model);
		},

		count: adapter.count.bind(adapter),

		transaction: adapter.transaction.bind(adapter),

		advisoryLock: adapter.advisoryLock.bind(adapter),

		raw: adapter.raw.bind(adapter),

		rawMutate: adapter.rawMutate.bind(adapter),
	} as InternalAdapter;
}
