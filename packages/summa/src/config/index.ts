import type { SummaOptions } from "@summa/core";
import { SummaError } from "@summa/core";

const VALID_CURRENCIES = new Set([
	"USD",
	"EUR",
	"GBP",
	"JPY",
	"CNY",
	"AUD",
	"CAD",
	"CHF",
	"HKD",
	"SGD",
	"SEK",
	"NOK",
	"DKK",
	"NZD",
	"ZAR",
	"KRW",
	"INR",
	"BRL",
	"MXN",
	"TWD",
	"THB",
	"MYR",
	"PHP",
	"IDR",
	"TRY",
	"RUB",
	"PLN",
	"CZK",
	"HUF",
	"ILS",
	"AED",
	"SAR",
	"QAR",
	"KWD",
	"BHD",
	"OMR",
	"CLP",
	"COP",
	"PEN",
	"ARS",
	"VND",
	"EGP",
	"NGN",
	"KES",
	"GHS",
	"XOF",
	"XAF",
	"XCD",
	"XPF",
]);

/**
 * Validate Summa configuration options at runtime.
 * Throws SummaError with clear messages on invalid configuration.
 */
export function validateConfig(options: SummaOptions): void {
	if (!options.database) {
		throw SummaError.invalidArgument("Summa config: 'database' adapter is required");
	}

	if (options.currency && !VALID_CURRENCIES.has(options.currency)) {
		throw SummaError.invalidArgument(
			`Summa config: unknown currency "${options.currency}". Use a valid ISO 4217 code.`,
		);
	}

	const adv = options.advanced;
	if (adv) {
		if (
			adv.hotAccountThreshold !== undefined &&
			(adv.hotAccountThreshold < 0 || !Number.isFinite(adv.hotAccountThreshold))
		) {
			throw SummaError.invalidArgument(
				"Summa config: 'advanced.hotAccountThreshold' must be a non-negative finite number",
			);
		}
		if (
			adv.idempotencyTTL !== undefined &&
			(adv.idempotencyTTL < 0 || !Number.isFinite(adv.idempotencyTTL))
		) {
			throw SummaError.invalidArgument(
				"Summa config: 'advanced.idempotencyTTL' must be a non-negative finite number",
			);
		}
		if (
			adv.transactionTimeoutMs !== undefined &&
			(adv.transactionTimeoutMs <= 0 || !Number.isFinite(adv.transactionTimeoutMs))
		) {
			throw SummaError.invalidArgument(
				"Summa config: 'advanced.transactionTimeoutMs' must be a positive finite number",
			);
		}
		if (
			adv.lockTimeoutMs !== undefined &&
			(adv.lockTimeoutMs <= 0 || !Number.isFinite(adv.lockTimeoutMs))
		) {
			throw SummaError.invalidArgument(
				"Summa config: 'advanced.lockTimeoutMs' must be a positive finite number",
			);
		}
		if (
			adv.maxTransactionAmount !== undefined &&
			(adv.maxTransactionAmount <= 0 || !Number.isFinite(adv.maxTransactionAmount))
		) {
			throw SummaError.invalidArgument(
				"Summa config: 'advanced.maxTransactionAmount' must be a positive finite number",
			);
		}
	}

	if (options.schema !== undefined) {
		if (typeof options.schema !== "string" || options.schema.length === 0) {
			throw SummaError.invalidArgument("Summa config: 'schema' must be a non-empty string");
		}
		if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(options.schema)) {
			throw SummaError.invalidArgument(
				`Summa config: 'schema' must contain only alphanumeric characters and underscores, got "${options.schema}"`,
			);
		}
	}

	if (options.systemAccounts) {
		for (const [key, value] of Object.entries(options.systemAccounts)) {
			if (typeof value === "string") {
				if (!value.startsWith("@")) {
					throw SummaError.invalidArgument(
						`Summa config: system account "${key}" identifier must start with "@", got "${value}"`,
					);
				}
			} else if (typeof value === "object" && value !== null) {
				if (!value.identifier?.startsWith("@")) {
					throw SummaError.invalidArgument(
						`Summa config: system account "${key}" identifier must start with "@"`,
					);
				}
			}
		}
	}
}

/**
 * Identity function for defining Summa configuration with autocomplete support.
 * Validates configuration at runtime before returning.
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
	validateConfig(options);
	return options;
}
