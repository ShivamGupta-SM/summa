// =============================================================================
// FETCH INTEGRATION — Web Fetch API handler for universal runtime support
// =============================================================================
// Works on Deno, Bun, Cloudflare Workers, Node 18+, and any runtime with
// the Web Fetch API (Request/Response).

import type { Summa } from "../summa/base.js";
import type { ApiHandlerOptions } from "./handler.js";
import { handleRequest } from "./handler.js";
import { parseWebApiRequest } from "./request-helpers.js";

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
		const apiReq = await parseWebApiRequest(request, basePath);
		const apiRes = await handleRequest(summa, apiReq, options);

		return new Response(apiRes.status === 204 ? null : JSON.stringify(apiRes.body), {
			status: apiRes.status,
			headers: apiRes.headers,
		});
	};
}
