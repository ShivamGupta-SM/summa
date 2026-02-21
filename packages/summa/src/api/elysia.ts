// =============================================================================
// ELYSIA INTEGRATION — Thin wrapper to mount Summa API routes in Elysia
// =============================================================================

import type { Summa } from "../summa/base.js";
import type { ApiHandlerOptions } from "./handler.js";
import { handleRequest } from "./handler.js";
import { parseWebHeaders, stripBasePath } from "./request-helpers.js";

/**
 * Create an Elysia plugin for the Summa API.
 *
 * @example
 * ```ts
 * import { Elysia } from "elysia";
 * import { createSummaElysia } from "summa/api/elysia";
 *
 * const app = new Elysia()
 *   .use(createSummaElysia(summa, { basePath: "/api/ledger" }))
 *   .listen(3000);
 * ```
 */
export function createSummaElysia(
	summa: Summa,
	options: { basePath?: string } & ApiHandlerOptions = {},
) {
	const basePath = options.basePath ?? "";

	return (app: {
		all: (
			path: string,
			handler: (context: {
				request: Request;
				body: unknown;
				query: Record<string, string | undefined>;
			}) => Promise<Response>,
		) => typeof app;
	}) => {
		return app.all(`${basePath}/*`, async (context) => {
			const url = new URL(context.request.url);

			let body: unknown = context.body;
			if (context.request.method === "GET" || context.request.method === "HEAD") {
				body = undefined;
			}

			const apiReq = {
				method: context.request.method,
				path: stripBasePath(url.pathname, basePath),
				body,
				query: context.query,
				headers: parseWebHeaders(context.request.headers),
			};

			const apiRes = await handleRequest(summa, apiReq, options);

			return new Response(apiRes.status === 204 ? null : JSON.stringify(apiRes.body), {
				status: apiRes.status,
				headers: apiRes.headers,
			});
		});
	};
}
