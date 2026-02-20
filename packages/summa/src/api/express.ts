// =============================================================================
// EXPRESS INTEGRATION — Thin wrapper to mount Summa API routes in Express
// =============================================================================

import type { Summa } from "../summa/base.js";
import type { ApiHandlerOptions, ApiRequest } from "./handler.js";
import { handleRequest } from "./handler.js";

/**
 * Create an Express-compatible router handler for the Summa API.
 *
 * @example
 * ```ts
 * import express from "express";
 * import { createSummaExpress } from "summa/api/express";
 *
 * const app = express();
 * app.use(express.json());
 * app.use("/api/ledger", createSummaExpress(summa));
 * ```
 */
export function createSummaExpress(summa: Summa, options?: ApiHandlerOptions) {
	return async (
		req: {
			method: string;
			path: string;
			body: unknown;
			query: Record<string, unknown>;
			headers: Record<string, string | string[] | undefined>;
		},
		res: {
			status: (code: number) => { json: (body: unknown) => void };
			set: (headers: Record<string, string>) => void;
		},
	) => {
		const query: Record<string, string | undefined> = {};
		for (const [key, value] of Object.entries(req.query)) {
			query[key] = typeof value === "string" ? value : undefined;
		}

		// Extract headers (flatten arrays to first value)
		const headers: Record<string, string> = {};
		for (const [key, value] of Object.entries(req.headers)) {
			if (typeof value === "string") {
				headers[key] = value;
			} else if (Array.isArray(value) && value.length > 0) {
				headers[key] = value[0] as string;
			}
		}

		const apiReq: ApiRequest = {
			method: req.method,
			path: req.path,
			body: req.body,
			query,
			headers,
		};

		const apiRes = await handleRequest(summa, apiReq, options);

		if (apiRes.headers) {
			res.set(apiRes.headers);
		}
		res.status(apiRes.status).json(apiRes.body);
	};
}
