import type { SummaAdapter } from "../db/adapter.js";
import type { SecondaryStorage } from "../db/secondary-storage.js";
import type { SummaPlugin } from "./plugin.js";

export interface SummaOptions {
	/** Database adapter instance or factory function */
	database: SummaAdapter | (() => SummaAdapter);

	/** Default currency code (default: "USD") */
	currency?: string;

	/** Functional currency for reporting consolidation (default: same as currency) */
	functionalCurrency?: string;

	/** System account identifiers (e.g., { world: "@World" }) */
	systemAccounts?: Record<string, SystemAccountDefinition | string>;

	/** Plugins to enable */
	plugins?: SummaPlugin[];

	/** Advanced configuration */
	advanced?: SummaAdvancedOptions;

	/** Custom logger */
	logger?: SummaLogger;

	/** Secondary storage (Redis, Memcached) for rate limiting, caching, etc. */
	secondaryStorage?: SecondaryStorage;

	/** PostgreSQL schema name for all Summa tables. Default: "summa" */
	schema?: string;
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
	/** HMAC secret for tamper-proof hash chain. Strongly recommended for production. */
	hmacSecret?: string;
	/** Verify event hash integrity on every read. Default: true */
	verifyHashOnRead?: boolean;

	// --- Performance scaling options ---

	/** Use denormalized balance columns on account_balance for O(1) reads. Default: false */
	useDenormalizedBalance?: boolean;
	/** Number of retry attempts when a transaction fails due to lock contention. Default: 0 (no retry) */
	lockRetryCount?: number;
	/** Base delay in ms between lock retries (doubled each attempt + jitter). Default: 50 */
	lockRetryBaseDelayMs?: number;
	/** Maximum delay in ms between lock retries. Default: 500 */
	lockRetryMaxDelayMs?: number;
	/** Lock acquisition mode. 'wait' blocks until lockTimeoutMs; 'nowait' fails immediately and retries. Default: 'wait' */
	lockMode?: "wait" | "nowait";
}

export interface SummaLogger {
	info(message: string, data?: Record<string, unknown>): void;
	warn(message: string, data?: Record<string, unknown>): void;
	error(message: string, data?: Record<string, unknown>): void;
	debug(message: string, data?: Record<string, unknown>): void;
}
