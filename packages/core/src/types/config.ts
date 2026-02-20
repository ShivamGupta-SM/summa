import type { SummaAdapter } from "../db/adapter.js";
import type { SummaPlugin } from "./plugin.js";

export interface SummaOptions {
	/** Database adapter instance or factory function */
	database: SummaAdapter | (() => SummaAdapter);

	/** Default currency code (default: "USD") */
	currency?: string;

	/** System account identifiers (e.g., { world: "@World" }) */
	systemAccounts?: Record<string, SystemAccountDefinition | string>;

	/** Plugins to enable */
	plugins?: SummaPlugin[];

	/** Advanced configuration */
	advanced?: SummaAdvancedOptions;

	/** Custom logger */
	logger?: SummaLogger;
}

export interface SystemAccountDefinition {
	identifier: string;
	name: string;
}

export interface SummaAdvancedOptions {
	/** Hot account batching threshold (txns/min). Default: 1000 */
	hotAccountThreshold?: number;
	/** Idempotency key TTL in ms. Default: 24h */
	idempotencyTTL?: number;
	/** Statement timeout in ms. Default: 5000 */
	transactionTimeoutMs?: number;
	/** Lock timeout in ms. Default: 3000 */
	lockTimeoutMs?: number;
	/** Maximum single transaction amount. Default: 1_000_000_000_00 */
	maxTransactionAmount?: number;
	/** Enable event sourcing. Default: true */
	enableEventSourcing?: boolean;
	/** Enable hash chain integrity. Default: true */
	enableHashChain?: boolean;
}

export interface SummaLogger {
	info(message: string, data?: Record<string, unknown>): void;
	warn(message: string, data?: Record<string, unknown>): void;
	error(message: string, data?: Record<string, unknown>): void;
	debug(message: string, data?: Record<string, unknown>): void;
}
