// =============================================================================
// VUE COMPOSABLES — Vue integration for the Summa client SDK
// =============================================================================

import { type InjectionKey, inject, onMounted, provide, type Ref, ref } from "vue";
import { normalizeError } from "./async-helpers.js";
import { createSummaClient, type SummaClient } from "./client.js";
import type { SummaClientOptions } from "./types.js";

// =============================================================================
// INJECTION KEY
// =============================================================================

const SUMMA_KEY: InjectionKey<SummaClient> = Symbol("summa-client");

export function provideSumma(options: SummaClientOptions): SummaClient {
	const client = createSummaClient(options);
	provide(SUMMA_KEY, client);
	return client;
}

export function useSummaClient(): SummaClient {
	const client = inject(SUMMA_KEY);
	if (!client) {
		throw new Error("useSummaClient requires provideSumma() in a parent component");
	}
	return client;
}

// =============================================================================
// QUERY COMPOSABLE
// =============================================================================

export interface SummaQueryReturn<T> {
	data: Ref<T | undefined>;
	error: Ref<Error | undefined>;
	loading: Ref<boolean>;
	refetch: () => Promise<void>;
}

export function useSummaQuery<T>(fn: (client: SummaClient) => Promise<T>): SummaQueryReturn<T> {
	const client = useSummaClient();
	const data = ref<T | undefined>(undefined) as Ref<T | undefined>;
	const error = ref<Error | undefined>(undefined) as Ref<Error | undefined>;
	const loading = ref(true);

	const refetch = async () => {
		loading.value = true;
		error.value = undefined;
		try {
			data.value = await fn(client);
		} catch (err) {
			error.value = normalizeError(err);
		} finally {
			loading.value = false;
		}
	};

	onMounted(() => {
		refetch();
	});

	return { data, error, loading, refetch };
}

// =============================================================================
// MUTATION COMPOSABLE
// =============================================================================

export interface SummaMutationReturn<T, V> {
	mutate: (variables: V) => Promise<T>;
	data: Ref<T | undefined>;
	error: Ref<Error | undefined>;
	loading: Ref<boolean>;
}

export function useSummaMutation<T, V = void>(
	fn: (client: SummaClient, variables: V) => Promise<T>,
): SummaMutationReturn<T, V> {
	const client = useSummaClient();
	const data = ref<T | undefined>(undefined) as Ref<T | undefined>;
	const error = ref<Error | undefined>(undefined) as Ref<Error | undefined>;
	const loading = ref(false);

	const mutate = async (variables: V): Promise<T> => {
		loading.value = true;
		error.value = undefined;
		try {
			const result = await fn(client, variables);
			data.value = result;
			return result;
		} catch (err) {
			const e = normalizeError(err);
			error.value = e;
			throw e;
		} finally {
			loading.value = false;
		}
	};

	return { mutate, data, error, loading };
}
