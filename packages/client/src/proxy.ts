// =============================================================================
// PROXY CLIENT — Dynamic method-to-URL mapping via JS Proxy
// =============================================================================
// Automatically maps property access chains to API paths.
//
// Usage:
//   const client = createSummaProxyClient({ baseURL: "..." });
//   client.admin.accounts.$get()           → GET /admin/accounts
//   client.admin.accounts("x").freeze.$post({ reason: "..." })
//                                          → POST /admin/accounts/x/freeze
//   client.accounts.$post({ holderId: "u1", holderType: "individual" })
//                                          → POST /accounts

import { createFetchClient, type FetchClient } from "./fetch.js";
import type { SummaClientOptions } from "./types.js";

type ProxyNode = {
	/** GET request to the current path */
	$get: (query?: Record<string, string | undefined>) => Promise<unknown>;
	/** POST request to the current path */
	$post: (body?: unknown) => Promise<unknown>;
	/** PUT request to the current path */
	$put: (body?: unknown) => Promise<unknown>;
	/** DELETE request to the current path */
	$delete: (body?: unknown) => Promise<unknown>;
} & {
	/** Access a sub-path segment */
	[key: string]: ProxyNode;
} & {
	/** Call with a param value to insert a dynamic path segment */
	(param: string): ProxyNode;
};

export function createSummaProxyClient(options: SummaClientOptions): ProxyNode {
	const http = createFetchClient(options);
	return buildProxy(http, "");
}

function buildProxy(http: FetchClient, path: string): ProxyNode {
	return new Proxy((() => {}) as unknown as ProxyNode, {
		get(_target, prop: string) {
			switch (prop) {
				case "$get":
					return (query?: Record<string, string | undefined>) => http.get(path, query);
				case "$post":
					return (body?: unknown) => http.post(path, body);
				case "$put":
					return (body?: unknown) => http.put(path, body);
				case "$delete":
					return (body?: unknown) => http.del(path, body);
				case "then":
					// Prevent auto-resolution when used with await on the proxy itself
					return undefined;
				default:
					return buildProxy(http, `${path}/${prop}`);
			}
		},
		apply(_target, _thisArg, args: unknown[]) {
			const param = String(args[0]);
			return buildProxy(http, `${path}/${encodeURIComponent(param)}`);
		},
	});
}
