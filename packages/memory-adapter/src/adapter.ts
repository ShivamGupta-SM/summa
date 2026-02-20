// =============================================================================
// MEMORY ADAPTER — SummaAdapter implementation backed by in-memory Maps
// =============================================================================
// Designed for unit testing. No external database required.
// Data is stored in nested Maps: model name -> record id -> record data.
// Supports all Where operators via in-memory filtering.

import type { SortBy, SummaAdapter, SummaTransactionAdapter, Where } from "@summa/core/db";

// =============================================================================
// INTERNAL HELPERS
// =============================================================================

type Store = Map<string, Map<string, Record<string, unknown>>>;

/**
 * Generate a UUID v4 string.
 */
function generateId(): string {
	return crypto.randomUUID();
}

/**
 * Deep clone a store for copy-on-write transaction support.
 */
function cloneStore(store: Store): Store {
	const clone: Store = new Map();
	for (const [model, records] of store) {
		const recordClone = new Map<string, Record<string, unknown>>();
		for (const [id, record] of records) {
			recordClone.set(id, { ...record });
		}
		clone.set(model, recordClone);
	}
	return clone;
}

/**
 * Get or create the model map for a given model name.
 */
function getModelStore(store: Store, model: string): Map<string, Record<string, unknown>> {
	let modelStore = store.get(model);
	if (!modelStore) {
		modelStore = new Map();
		store.set(model, modelStore);
	}
	return modelStore;
}

/**
 * Evaluate a single Where condition against a record.
 */
function matchesCondition(record: Record<string, unknown>, condition: Where): boolean {
	const value = record[condition.field];

	switch (condition.operator) {
		case "eq":
			return value === condition.value;
		case "ne":
			return value !== condition.value;
		case "gt":
			return (value as number) > (condition.value as number);
		case "gte":
			return (value as number) >= (condition.value as number);
		case "lt":
			return (value as number) < (condition.value as number);
		case "lte":
			return (value as number) <= (condition.value as number);
		case "in":
			return (condition.value as unknown[]).includes(value);
		case "like": {
			if (typeof value !== "string" || typeof condition.value !== "string") {
				return false;
			}
			// Convert SQL LIKE pattern to RegExp:
			// % matches any sequence of characters, _ matches any single character
			const pattern = condition.value
				.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") // escape regex special chars
				.replace(/%/g, ".*")
				.replace(/_/g, ".");
			return new RegExp(`^${pattern}$`, "i").test(value);
		}
		case "is_null":
			return value === null || value === undefined;
		case "is_not_null":
			return value !== null && value !== undefined;
		default:
			return false;
	}
}

/**
 * Filter records by an array of Where conditions (all must match — AND logic).
 */
function filterRecords(
	records: Map<string, Record<string, unknown>>,
	where: Where[],
): Record<string, unknown>[] {
	const results: Record<string, unknown>[] = [];
	for (const record of records.values()) {
		if (where.every((w) => matchesCondition(record, w))) {
			results.push(record);
		}
	}
	return results;
}

/**
 * Sort records by a SortBy specification.
 */
function sortRecords(
	records: Record<string, unknown>[],
	sortBy: SortBy,
): Record<string, unknown>[] {
	return [...records].sort((a, b) => {
		const aVal = a[sortBy.field];
		const bVal = b[sortBy.field];

		if (aVal === bVal) return 0;
		if (aVal === null || aVal === undefined) return 1;
		if (bVal === null || bVal === undefined) return -1;

		const comparison = aVal < bVal ? -1 : 1;
		return sortBy.direction === "desc" ? -comparison : comparison;
	});
}

// =============================================================================
// ADAPTER METHODS BUILDER
// =============================================================================

/**
 * Build the core adapter methods for a given store reference.
 * The storeRef is a closure so that transaction rollbacks can swap it.
 */
function buildAdapterMethods(
	getStore: () => Store,
	_setStore: (s: Store) => void,
): Omit<SummaTransactionAdapter, "id" | "options"> {
	return {
		create: async <T extends Record<string, unknown>>({
			model,
			data,
		}: {
			model: string;
			data: T;
		}): Promise<T> => {
			const store = getStore();
			const modelStore = getModelStore(store, model);

			const record = { ...data } as Record<string, unknown>;
			if (!record.id) {
				record.id = generateId();
			}

			modelStore.set(record.id as string, record);
			return { ...record } as T;
		},

		findOne: async <T>({
			model,
			where,
		}: {
			model: string;
			where: Where[];
			forUpdate?: boolean;
		}): Promise<T | null> => {
			const store = getStore();
			const modelStore = store.get(model);
			if (!modelStore) return null;

			const matches = filterRecords(modelStore, where);
			const first = matches[0];
			if (!first) return null;
			return { ...first } as T;
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
			const store = getStore();
			const modelStore = store.get(model);
			if (!modelStore) return [];

			let results = filterRecords(modelStore, where ?? []);

			if (sortBy) {
				results = sortRecords(results, sortBy);
			}

			if (offset !== undefined) {
				results = results.slice(offset);
			}

			if (limit !== undefined) {
				results = results.slice(0, limit);
			}

			return results.map((r) => ({ ...r }) as T);
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
			const store = getStore();
			const modelStore = store.get(model);
			if (!modelStore) return null;

			const matches = filterRecords(modelStore, where);
			const first = matches[0];
			if (!first) return null;

			const updated = { ...first, ...updateData };
			modelStore.set(updated.id as string, updated);
			return { ...updated } as T;
		},

		delete: async ({ model, where }: { model: string; where: Where[] }): Promise<void> => {
			const store = getStore();
			const modelStore = store.get(model);
			if (!modelStore) return;

			const matches = filterRecords(modelStore, where);
			for (const match of matches) {
				modelStore.delete(match.id as string);
			}
		},

		count: async ({ model, where }: { model: string; where?: Where[] }): Promise<number> => {
			const store = getStore();
			const modelStore = store.get(model);
			if (!modelStore) return 0;

			if (!where || where.length === 0) {
				return modelStore.size;
			}

			return filterRecords(modelStore, where).length;
		},

		advisoryLock: async (_key: number): Promise<void> => {
			// No-op in memory adapter — single process, no concurrent access
		},

		raw: async <T>(_sql: string, _params: unknown[]): Promise<T[]> => {
			throw new Error("Not supported in memory adapter");
		},

		rawMutate: async (_sql: string, _params: unknown[]): Promise<number> => {
			throw new Error("Not supported in memory adapter");
		},
	};
}

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Create a SummaAdapter backed by an in-memory store.
 * Ideal for unit testing — no database required.
 *
 * @returns A SummaAdapter implementation
 *
 * @example
 * ```ts
 * import { memoryAdapter } from "@summa/memory-adapter";
 *
 * const adapter = memoryAdapter();
 *
 * await adapter.create({ model: "user", data: { name: "Alice" } });
 * const user = await adapter.findOne({ model: "user", where: [{ field: "name", operator: "eq", value: "Alice" }] });
 * ```
 */
export function memoryAdapter(): SummaAdapter {
	let store: Store = new Map();

	const getStore = () => store;
	const setStore = (s: Store) => {
		store = s;
	};

	const methods = buildAdapterMethods(getStore, setStore);

	return {
		id: "memory",
		...methods,

		transaction: async <T>(fn: (tx: SummaTransactionAdapter) => Promise<T>): Promise<T> => {
			// Copy-on-write: snapshot before transaction, rollback on error
			const snapshot = cloneStore(store);

			try {
				const txMethods = buildAdapterMethods(getStore, setStore);
				const txAdapter: SummaTransactionAdapter = {
					id: "memory",
					...txMethods,
					options: {
						supportsAdvisoryLocks: false,
						supportsForUpdate: false,
						supportsReturning: true,
						dialectName: "sqlite",
					},
				};
				return await fn(txAdapter);
			} catch (error) {
				// Rollback: restore the snapshot
				store = snapshot;
				throw error;
			}
		},

		options: {
			supportsAdvisoryLocks: false,
			supportsForUpdate: false,
			supportsReturning: true,
			dialectName: "sqlite",
		},
	};
}
