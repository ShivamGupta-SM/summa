// =============================================================================
// CLIENT SDK TYPES
// =============================================================================

export interface SummaClientOptions {
	/** Base URL of the Summa API (e.g., "http://localhost:3000/api/ledger") */
	baseURL: string;

	/** Static headers to include in every request */
	headers?: Record<string, string>;

	/** Custom fetch implementation (default: globalThis.fetch) */
	fetch?: typeof globalThis.fetch;

	/** Request interceptors */
	onRequest?: RequestInterceptor | RequestInterceptor[];

	/** Response interceptors */
	onResponse?: ResponseInterceptor | ResponseInterceptor[];

	/** Timeout in milliseconds (default: 30000) */
	timeout?: number;
}

export type RequestInterceptor = (
	url: string,
	init: RequestInit,
) => RequestInit | Promise<RequestInit>;

export type ResponseInterceptor = (
	response: Response,
	request: { url: string; init: RequestInit },
) => Response | Promise<Response>;

// =============================================================================
// TYPE INFERENCE
// =============================================================================

/**
 * Infer a typed SummaClient from a server-side Summa instance.
 * Carries plugin `$Infer` types through to the client for DX.
 *
 * @example
 * ```ts
 * import type { summa } from "./summa.config";
 * import type { InferSummaClient } from "@summa/client";
 *
 * type Client = InferSummaClient<typeof summa>;
 * // Client.$types.HotAccountStats is available
 * ```
 */
export type InferSummaClient<TSumma> = TSumma extends { $Infer: infer TInfer }
	? import("./client.js").SummaClient & { $types: TInfer }
	: import("./client.js").SummaClient;
