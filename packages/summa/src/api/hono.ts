// =============================================================================
// HONO INTEGRATION — Thin wrapper to mount Summa API routes in Hono
// =============================================================================

import type { Summa } from "../summa/base.js";
import type { ApiHandlerOptions } from "./handler.js";
import { handleRequest } from "./handler.js";
import {
	parseSearchParams,
	parseWebBody,
	parseWebHeaders,
	stripBasePath,
} from "./request-helpers.js";

/**
 * Create a Hono-compatible handler for the Summa API.
 *
 * @example
 * ```ts
 * import { Hono } from "hono";
 * import { createSummaHono } from "summa/api/hono";
 *
 * const app = new Hono();
 * app.all("/api/ledger/*", createSummaHono(summa, { basePath: "/api/ledger" }));
 * ```
 */
export function createSummaHono(
	summa: Summa,
	options: { basePath?: string } & ApiHandlerOptions = {},
) {
	const basePath = options.basePath ?? "";

	return async (c: {
		req: {
			method: string;
			url: string;
			json: () => Promise<unknown>;
			query: (key: string) => string | undefined;
			header: (name: string) => string | undefined;
			raw: { headers: Headers };
		};
		json: (body: unknown, status: number, headers?: Record<string, string>) => unknown;
	}) => {
		const url = new URL(c.req.url);

		const apiReq = {
			method: c.req.method,
			path: stripBasePath(url.pathname, basePath),
			body: await parseWebBody(c.req),
			query: parseSearchParams(url.searchParams),
			headers: parseWebHeaders(c.req.raw.headers),
		};

		const res = await handleRequest(summa, apiReq, options);
		return c.json(res.body, res.status, res.headers);
	};
}
