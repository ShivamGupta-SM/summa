// =============================================================================
// NEXT.JS INTEGRATION — Route handler for Next.js App Router
// =============================================================================

import type { Summa } from "../summa/base.js";
import { createSummaFetchHandler } from "./fetch.js";
import type { ApiHandlerOptions } from "./handler.js";

/**
 * Create Next.js App Router route handlers for the Summa API.
 *
 * @example
 * ```ts
 * // app/api/ledger/[...path]/route.ts
 * import { createSummaNextHandler } from "summa/api/next";
 *
 * const { GET, POST, PUT, PATCH, DELETE } = createSummaNextHandler(summa, {
 *   basePath: "/api/ledger",
 * });
 *
 * export { GET, POST, PUT, PATCH, DELETE };
 * ```
 */
export function createSummaNextHandler(
	summa: Summa,
	options: { basePath?: string } & ApiHandlerOptions = {},
): {
	GET: (request: Request) => Promise<Response>;
	POST: (request: Request) => Promise<Response>;
	PUT: (request: Request) => Promise<Response>;
	PATCH: (request: Request) => Promise<Response>;
	DELETE: (request: Request) => Promise<Response>;
} {
	const handler = createSummaFetchHandler(summa, options);

	return {
		GET: handler,
		POST: handler,
		PUT: handler,
		PATCH: handler,
		DELETE: handler,
	};
}
