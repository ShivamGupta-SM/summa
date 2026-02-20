// =============================================================================
// HONO INTEGRATION — Thin wrapper to mount Summa API routes in Hono
// =============================================================================

import type { Summa } from "../summa/base.js";
import type { ApiHandlerOptions, ApiRequest } from "./handler.js";
import { handleRequest } from "./handler.js";

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
		let path = url.pathname;
		if (basePath && path.startsWith(basePath)) {
			path = path.slice(basePath.length) || "/";
		}

		let body: unknown;
		if (c.req.method !== "GET" && c.req.method !== "HEAD") {
			try {
				body = await c.req.json();
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
		c.req.raw.headers.forEach((value, key) => {
			headers[key] = value;
		});

		const apiReq: ApiRequest = {
			method: c.req.method,
			path,
			body,
			query,
			headers,
		};

		const res = await handleRequest(summa, apiReq, options);
		return c.json(res.body, res.status, res.headers);
	};
}
