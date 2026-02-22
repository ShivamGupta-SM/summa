// =============================================================================
// EXPRESS INTEGRATION — Thin wrapper to mount Summa API routes in Express
// =============================================================================

import type { Summa } from "../summa/base.js";
import type { ApiHandlerOptions } from "./handler.js";
import { handleRequest } from "./handler.js";
import { parseNodeHeaders, parseNodeQuery } from "./request-helpers.js";

/**
 * Create an Express-compatible router handler for the Summa API.
 *
 * @example
 * ```ts
 * import express from "express";
 * import { createSummaExpress } from "@summa-ledger/summa/api/express";
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
		const apiReq = {
			method: req.method,
			path: req.path,
			body: req.body,
			query: parseNodeQuery(req.query),
			headers: parseNodeHeaders(req.headers),
		};

		const apiRes = await handleRequest(summa, apiReq, options);

		if (apiRes.headers) {
			res.set(apiRes.headers);
		}
		res.status(apiRes.status).json(apiRes.body);
	};
}
