// =============================================================================
// ENCORE INTEGRATION — Raw endpoint handler for Encore.ts
// =============================================================================
// Encore.ts uses raw endpoints for custom HTTP handling. This adapter
// creates a handler compatible with Encore's `api.raw()`.

import type { Summa } from "../summa/base.js";
import { createSummaFetchHandler } from "./fetch.js";
import type { ApiHandlerOptions } from "./handler.js";

/**
 * Create an Encore.ts raw endpoint handler for the Summa API.
 *
 * @example
 * ```ts
 * // ledger/ledger.ts
 * import { api } from "encore.dev/api";
 * import { createSummaEncore } from "@summa-ledger/summa/api/encore";
 *
 * const handler = createSummaEncore(summa, { basePath: "/ledger" });
 *
 * export const ledger = api.raw(
 *   { expose: true, method: "*", path: "/ledger/*path" },
 *   handler,
 * );
 * ```
 */
export function createSummaEncore(
	summa: Summa,
	options: { basePath?: string } & ApiHandlerOptions = {},
): (req: Request) => Promise<Response> {
	return createSummaFetchHandler(summa, options);
}
