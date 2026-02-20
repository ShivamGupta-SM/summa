// =============================================================================
// SVELTE STORES — Svelte integration for the Summa client SDK
// =============================================================================

import { get, type Readable, type Writable, writable } from "svelte/store";
import { createSummaClient, type SummaClient } from "./client.js";
import type { SummaClientOptions } from "./types.js";

// =============================================================================
// STORE TYPES
// =============================================================================

export interface SummaQueryStore<T>
	extends Readable<{
		data: T | undefined;
		error: Error | undefined;
		loading: boolean;
	}> {
	refetch: () => Promise<void>;
}

export interface SummaMutationStore<T, V>
	extends Readable<{
		data: T | undefined;
		error: Error | undefined;
		loading: boolean;
	}> {
	trigger: (variables: V) => Promise<T>;
}

// =============================================================================
// FACTORY
// =============================================================================

export interface SummaStore {
	client: SummaClient;
	query: <T>(fn: (client: SummaClient) => Promise<T>) => SummaQueryStore<T>;
	mutation: <T, V = void>(
		fn: (client: SummaClient, variables: V) => Promise<T>,
	) => SummaMutationStore<T, V>;
}

export function createSummaStore(options: SummaClientOptions): SummaStore {
	const client = createSummaClient(options);

	function query<T>(fn: (client: SummaClient) => Promise<T>): SummaQueryStore<T> {
		const store: Writable<{ data: T | undefined; error: Error | undefined; loading: boolean }> =
			writable({ data: undefined, error: undefined, loading: true });

		const refetch = async () => {
			store.set({ ...get(store), loading: true, error: undefined });
			try {
				const data = await fn(client);
				store.set({ data, error: undefined, loading: false });
			} catch (err) {
				store.set({
					...get(store),
					error: err instanceof Error ? err : new Error(String(err)),
					loading: false,
				});
			}
		};

		// Auto-fetch on creation
		refetch();

		return {
			subscribe: store.subscribe,
			refetch,
		};
	}

	function mutation<T, V = void>(
		fn: (client: SummaClient, variables: V) => Promise<T>,
	): SummaMutationStore<T, V> {
		const store: Writable<{ data: T | undefined; error: Error | undefined; loading: boolean }> =
			writable({ data: undefined, error: undefined, loading: false });

		const trigger = async (variables: V): Promise<T> => {
			store.set({ ...get(store), loading: true, error: undefined });
			try {
				const data = await fn(client, variables);
				store.set({ data, error: undefined, loading: false });
				return data;
			} catch (err) {
				const e = err instanceof Error ? err : new Error(String(err));
				store.set({ ...get(store), error: e, loading: false });
				throw e;
			}
		};

		return {
			subscribe: store.subscribe,
			trigger,
		};
	}

	return { client, query, mutation };
}
