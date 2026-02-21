// =============================================================================
// REACT HOOKS — React integration for the Summa client SDK
// =============================================================================

import {
	createContext,
	createElement,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import { normalizeError } from "./async-helpers.js";
import { createSummaClient, type SummaClient } from "./client.js";
import type { SummaClientOptions } from "./types.js";

// =============================================================================
// CONTEXT
// =============================================================================

const SummaContext = createContext<SummaClient | null>(null);

export interface SummaProviderProps {
	options: SummaClientOptions;
	children: ReactNode;
}

export function SummaProvider({ options, children }: SummaProviderProps) {
	const clientRef = useRef<SummaClient | null>(null);
	if (!clientRef.current) {
		clientRef.current = createSummaClient(options);
	}
	return createElement(SummaContext.Provider, { value: clientRef.current }, children);
}

export function useSumma(): SummaClient {
	const client = useContext(SummaContext);
	if (!client) {
		throw new Error("useSumma must be used within a <SummaProvider>");
	}
	return client;
}

// =============================================================================
// QUERY HOOK
// =============================================================================

export interface SummaQueryResult<T> {
	data: T | undefined;
	error: Error | undefined;
	loading: boolean;
	refetch: () => void;
}

export function useSummaQuery<T>(
	fn: (client: SummaClient) => Promise<T>,
	_deps: unknown[] = [],
): SummaQueryResult<T> {
	const client = useSumma();
	const [data, setData] = useState<T | undefined>(undefined);
	const [error, setError] = useState<Error | undefined>(undefined);
	const [loading, setLoading] = useState(true);
	const [_trigger, setTrigger] = useState(0);

	const refetch = useCallback(() => setTrigger((n) => n + 1), []);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		setError(undefined);

		(async () => {
			try {
				const result = await fn(client);
				if (!cancelled) {
					setData(result);
					setLoading(false);
				}
			} catch (err: unknown) {
				if (!cancelled) {
					setError(normalizeError(err));
					setLoading(false);
				}
			}
		})();

		return () => {
			cancelled = true;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [client, fn, _trigger]);

	return { data, error, loading, refetch };
}

// =============================================================================
// MUTATION HOOK
// =============================================================================

export interface SummaMutationResult<T, V> {
	mutate: (variables: V) => Promise<T>;
	data: T | undefined;
	error: Error | undefined;
	loading: boolean;
}

export function useSummaMutation<T, V = void>(
	fn: (client: SummaClient, variables: V) => Promise<T>,
): SummaMutationResult<T, V> {
	const client = useSumma();
	const [data, setData] = useState<T | undefined>(undefined);
	const [error, setError] = useState<Error | undefined>(undefined);
	const [loading, setLoading] = useState(false);

	const mutate = useCallback(
		async (variables: V): Promise<T> => {
			setLoading(true);
			setError(undefined);
			try {
				const result = await fn(client, variables);
				setData(result);
				return result;
			} catch (err) {
				const e = normalizeError(err);
				setError(e);
				throw e;
			} finally {
				setLoading(false);
			}
		},
		[client, fn],
	);

	return { mutate, data, error, loading };
}
