// =============================================================================
// FETCH WRAPPER — Internal fetch with interceptors, timeout, error parsing
// =============================================================================

import type { SummaErrorCode } from "@summa-ledger/core";
import { SummaClientError } from "./error.js";
import type { RequestInterceptor, ResponseInterceptor, SummaClientOptions } from "./types.js";

export interface FetchClient {
	get<T>(path: string, query?: Record<string, string | undefined>): Promise<T>;
	post<T>(path: string, body?: unknown): Promise<T>;
	put<T>(path: string, body?: unknown): Promise<T>;
	del<T>(path: string, body?: unknown): Promise<T>;
}

export function createFetchClient(options: SummaClientOptions): FetchClient {
	const fetchFn = options.fetch ?? globalThis.fetch;
	const timeout = options.timeout ?? 30_000;
	const baseHeaders: Record<string, string> = {
		"Content-Type": "application/json",
		...options.headers,
	};

	const requestInterceptors: RequestInterceptor[] = options.onRequest
		? Array.isArray(options.onRequest)
			? options.onRequest
			: [options.onRequest]
		: [];

	const responseInterceptors: ResponseInterceptor[] = options.onResponse
		? Array.isArray(options.onResponse)
			? options.onResponse
			: [options.onResponse]
		: [];

	async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
		const url = `${options.baseURL}${path}`;

		let init: RequestInit = {
			method,
			headers: { ...baseHeaders },
			signal: AbortSignal.timeout(timeout),
		};

		if (body !== undefined && method !== "GET") {
			init.body = JSON.stringify(body);
		}

		// Run request interceptors
		for (const interceptor of requestInterceptors) {
			init = await interceptor(url, init);
		}

		let response = await fetchFn(url, init);

		// Run response interceptors
		for (const interceptor of responseInterceptors) {
			response = await interceptor(response, { url, init });
		}

		if (!response.ok) {
			const errorBody = (await response.json().catch(() => null)) as {
				error?: { code?: string; message?: string; details?: Record<string, unknown> };
			} | null;

			throw new SummaClientError(
				(errorBody?.error?.code ?? "INTERNAL") as SummaErrorCode,
				errorBody?.error?.message ?? `HTTP ${response.status}`,
				response.status,
				errorBody?.error?.details as Record<string, unknown> | undefined,
			);
		}

		// 204 No Content
		if (response.status === 204) {
			return undefined as T & undefined;
		}

		return response.json() as Promise<T>;
	}

	return {
		async get<T>(path: string, query?: Record<string, string | undefined>): Promise<T> {
			let fullPath = path;
			if (query) {
				const params = new URLSearchParams();
				for (const [key, value] of Object.entries(query)) {
					if (value !== undefined) params.set(key, value);
				}
				const qs = params.toString();
				if (qs) fullPath += `?${qs}`;
			}
			return request<T>("GET", fullPath);
		},
		async post<T>(path: string, body?: unknown): Promise<T> {
			return request<T>("POST", path, body);
		},
		async put<T>(path: string, body?: unknown): Promise<T> {
			return request<T>("PUT", path, body);
		},
		async del<T>(path: string, body?: unknown): Promise<T> {
			return request<T>("DELETE", path, body);
		},
	};
}
