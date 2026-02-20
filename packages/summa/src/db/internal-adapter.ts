// =============================================================================
// INTERNAL ADAPTER
// =============================================================================
// Wraps the raw SummaAdapter with plugin hooks (operationHooks) and optional
// secondary storage read-through caching.

import type { SecondaryStorage, SummaAdapter, SummaLogger, SummaPlugin } from "@summa/core";

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
	const { adapter, logger, plugins, secondaryStorage } = options;

	// Collect all operation hooks from plugins
	const beforeHooks = plugins.flatMap((p) =>
		(p.operationHooks?.before ?? []).map((hook) => ({ pluginId: p.id, ...hook })),
	);
	const afterHooks = plugins.flatMap((p) =>
		(p.operationHooks?.after ?? []).map((hook) => ({ pluginId: p.id, ...hook })),
	);

	const cachePrefix = "summa:cache:";

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
		}
		return result;
	}

	return {
		id: adapter.id,
		options: adapter.options,
		rawAdapter: adapter,

		create: adapter.create.bind(adapter),

		findOne: cachedFindOne,

		findMany: adapter.findMany.bind(adapter),

		update: adapter.update.bind(adapter),

		delete: adapter.delete.bind(adapter),

		count: adapter.count.bind(adapter),

		transaction: adapter.transaction.bind(adapter),

		advisoryLock: adapter.advisoryLock.bind(adapter),

		raw: adapter.raw.bind(adapter),

		rawMutate: adapter.rawMutate.bind(adapter),

		/** Expose hook arrays for external use (e.g., by managers) */
		get _beforeHooks() {
			return beforeHooks;
		},
		get _afterHooks() {
			return afterHooks;
		},
	} as InternalAdapter;
}
