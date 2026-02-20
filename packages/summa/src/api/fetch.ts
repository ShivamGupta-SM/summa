// =============================================================================
// FETCH INTEGRATION — Web Fetch API handler for universal runtime support
// =============================================================================
// Works on Deno, Bun, Cloudflare Workers, Node 18+, and any runtime with
// the Web Fetch API (Request/Response).

import type { Summa } from "../summa/base.js";
import type { ApiHandlerOptions, ApiRequest } from "./handler.js";
import { handleRequest } from "./handler.js";

/**
 * Create a Web Fetch API compatible handler for the Summa API.
 *
 * @example
 * ```ts
 * import { createSummaFetchHandler } from "summa/api/fetch";
 *
 * const handler = createSummaFetchHandler(summa, { basePath: "/api/ledger" });
 *
 * // Deno
 * Deno.serve(handler);
 *
 * // Bun
 * export default { fetch: handler };
 *
 * // Cloudflare Workers
 * export default { fetch: handler };
 * ```
 */
export function createSummaFetchHandler(
	summa: Summa,
	options: { basePath?: string } & ApiHandlerOptions = {},
): (request: Request) => Promise<Response> {
	const basePath = options.basePath ?? "";

	return async (request: Request): Promise<Response> => {
		const url = new URL(request.url);
		let path = url.pathname;
		if (basePath && path.startsWith(basePath)) {
			path = path.slice(basePath.length) || "/";
		}

		let body: unknown;
		if (request.method !== "GET" && request.method !== "HEAD") {
			try {
				body = await request.json();
			} catch {
				body = {};
			}
		}

		const query: Record<string, string | undefined> = {};
		for (const [key, value] of url.searchParams) {
			query[key] = value;
		}

		// Extract headers
		const headers: Record<string, string> = {};
		request.headers.forEach((value, key) => {
			headers[key] = value;
		});

		const apiReq: ApiRequest = {
			method: request.method,
			path,
			body,
			query,
			headers,
		};

		const apiRes = await handleRequest(summa, apiReq, options);

		return new Response(apiRes.status === 204 ? null : JSON.stringify(apiRes.body), {
			status: apiRes.status,
			headers: apiRes.headers,
		});
	};
}
