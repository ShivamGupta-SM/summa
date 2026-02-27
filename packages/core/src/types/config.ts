import type { SummaAdapter } from "../db/adapter.js";
import type { SecondaryStorage } from "../db/secondary-storage.js";
import type { SummaPlugin } from "./plugin.js";

export interface CoreWorkerOptions {
	/** Hold expiry worker. Expires holds past their hold_expires_at date. Default: enabled, 5m interval */
	holdExpiry?: boolean | { interval?: string };
	/** Idempotency key cleanup worker. Removes expired keys. Default: enabled, 1h interval */
	idempotencyCleanup?: boolean | { interval?: string };
	/** Worker lease cleanup. Removes stale leases from dead instances. Default: enabled, 6h interval */
	leaseCleanup?: boolean | { interval?: string };
}

export interface SummaOptions {
	/** Database adapter instance or factory function */
	database: SummaAdapter | (() => SummaAdapter);

	/** Optional read replica adapter for read-only queries. Writes always go to primary. */
	readDatabase?: SummaAdapter | (() => SummaAdapter);

	/** Default currency code (default: "USD") */
	currency?: string;

	/** Functional currency for reporting consolidation (default: same as currency) */
	functionalCurrency?: string;

	/** System account identifiers (e.g., { world: "@World" }) */
	systemAccounts?: Record<string, SystemAccountDefinition | string>;

	/** Plugins to enable */
	plugins?: SummaPlugin[];

	/** Core background workers. All enabled by default. */
	coreWorkers?: CoreWorkerOptions;

	/** Advanced configuration */
	advanced?: SummaAdvancedOptions;

	/** Custom logger */
	logger?: SummaLogger;

	/** Secondary storage (Redis, Memcached) for rate limiting, caching, etc. */
	secondaryStorage?: SecondaryStorage;

	/** PostgreSQL schema name for all Summa tables. Default: "summa" */
	schema?: string;

	/** Default ledger ID. Used when requestContext.ledgerId is not set. */
	ledgerId?: string;
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
	/** HMAC secret for tamper-proof hash chain. Strongly recommended for production. */
	hmacSecret?: string;
	/** Verify entry hash integrity on every read. Default: true */
	verifyEntryHashOnRead?: boolean;

	// --- Performance scaling options ---

	/** Number of retry attempts when a transaction fails due to lock contention. Default: 0 (no retry) */
	lockRetryCount?: number;
	/** Base delay in ms between lock retries (doubled each attempt + jitter). Default: 50 */
	lockRetryBaseDelayMs?: number;
	/** Maximum delay in ms between lock retries. Default: 500 */
	lockRetryMaxDelayMs?: number;
	/** Lock acquisition mode. 'wait' blocks until lockTimeoutMs; 'nowait' fails immediately and retries; 'optimistic' skips FOR UPDATE and retries on version conflict. Default: 'wait' */
	lockMode?: "wait" | "nowait" | "optimistic";
	/** Max retries for optimistic lock version conflicts. Only used when lockMode='optimistic'. Default: 3 */
	optimisticRetryCount?: number;

	// --- Transaction batching (Phase 3 performance) ---

	/** Enable transaction batching for high-throughput mode. Default: false */
	enableBatching?: boolean;
	/** Max transactions per batch (only used when enableBatching=true). Default: 200 */
	batchMaxSize?: number;
	/** Max flush delay in ms before an incomplete batch is processed. Default: 5 */
	batchFlushIntervalMs?: number;
}

export interface SummaLogger {
	info(message: string, data?: Record<string, unknown>): void;
	warn(message: string, data?: Record<string, unknown>): void;
	error(message: string, data?: Record<string, unknown>): void;
	debug(message: string, data?: Record<string, unknown>): void;
}
