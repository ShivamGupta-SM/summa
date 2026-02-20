import type { SummaOptions } from "@summa/core";

/**
 * Identity function for defining Summa configuration with autocomplete support.
 *
 * @example
 * ```ts
 * import { defineSummaConfig } from "summa/config";
 *
 * export default defineSummaConfig({
 *   database: drizzleAdapter(db),
 *   currency: "USD",
 *   plugins: [],
 * });
 * ```
 */
export function defineSummaConfig(options: SummaOptions): SummaOptions {
	return options;
}
