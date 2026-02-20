// =============================================================================
// FASTIFY INTEGRATION — Plugin to mount Summa API routes in Fastify
// =============================================================================

import type { Summa } from "../summa/base.js";
import type { ApiHandlerOptions, ApiRequest } from "./handler.js";
import { handleRequest } from "./handler.js";

/**
 * Create a Fastify plugin for the Summa API.
 *
 * @example
 * ```ts
 * import Fastify from "fastify";
 * import { createSummaFastify } from "summa/api/fastify";
 *
 * const app = Fastify();
 * app.register(createSummaFastify(summa), { prefix: "/api/ledger" });
 * ```
 */
export function createSummaFastify(summa: Summa, options?: ApiHandlerOptions) {
	return async (fastify: {
		all: (
			path: string,
			handler: (
				request: {
					method: string;
					url: string;
					body: unknown;
					query: Record<string, unknown>;
					headers: Record<string, string | string[] | undefined>;
				},
				reply: {
					status: (code: number) => {
						headers: (headers: Record<string, string>) => {
							send: (body: unknown) => void;
						};
						send: (body: unknown) => void;
					};
				},
			) => Promise<void>,
		) => void;
	}) => {
		fastify.all("/*", async (request, reply) => {
			// Extract path from URL (strip query string)
			const urlPath = request.url.split("?")[0] ?? "/";

			const query: Record<string, string | undefined> = {};
			for (const [key, value] of Object.entries(request.query)) {
				query[key] = typeof value === "string" ? value : undefined;
			}

			// Extract headers (flatten arrays to first value)
			const headers: Record<string, string> = {};
			for (const [key, value] of Object.entries(request.headers)) {
				if (typeof value === "string") {
					headers[key] = value;
				} else if (Array.isArray(value) && value.length > 0) {
					headers[key] = value[0] as string;
				}
			}

			const apiReq: ApiRequest = {
				method: request.method,
				path: urlPath,
				body: request.body,
				query,
				headers,
			};

			const apiRes = await handleRequest(summa, apiReq, options);

			reply
				.status(apiRes.status)
				.headers(apiRes.headers ?? {})
				.send(apiRes.body);
		});
	};
}
