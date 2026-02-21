import type { SummaAdapter } from "../db/adapter.js";
import type { SqlDialect } from "../db/dialect.js";
import type { SummaLogger } from "./config.js";
import type { SummaPlugin } from "./plugin.js";

export interface RequestContext {
	requestId: string;
	actor?: string;
	metadata?: Record<string, unknown>;
}

/** Resolves a cross-currency exchange rate. Returns scaled integer (rate × 1_000_000). */
export type FxResolver = (from: string, to: string) => Promise<number>;

export interface SummaContext {
	adapter: SummaAdapter;
	dialect: SqlDialect;
	options: ResolvedSummaOptions;
	logger: SummaLogger;
	plugins: SummaPlugin[];
	requestContext?: RequestContext;
	/** Optional FX resolver, registered by the fx-engine plugin */
	fxResolver?: FxResolver;
	/** Pre-computed hook cache for performance. Built at context creation. */
	_hookCache?: {
		beforeTransaction: SummaPlugin[];
		afterTransaction: SummaPlugin[];
		beforeAccountCreate: SummaPlugin[];
		afterAccountCreate: SummaPlugin[];
		beforeHoldCreate: SummaPlugin[];
		afterHoldCommit: SummaPlugin[];
		beforeOperation: SummaPlugin[];
		afterOperation: SummaPlugin[];
	};
}

export interface ResolvedSummaOptions {
	currency: string;
	/** Functional currency for reporting consolidation (defaults to currency) */
	functionalCurrency: string;
	systemAccounts: Record<string, string>;
	advanced: ResolvedAdvancedOptions;
	/** PostgreSQL schema for all Summa tables. Default: "summa" */
	schema: string;
}

export interface ResolvedAdvancedOptions {
	hotAccountThreshold: number;
	idempotencyTTL: number;
	transactionTimeoutMs: number;
	lockTimeoutMs: number;
	maxTransactionAmount: number;
	enableEventSourcing: boolean;
	enableHashChain: boolean;
	hmacSecret: string | null;
	verifyHashOnRead: boolean;
	useDenormalizedBalance: boolean;
	lockRetryCount: number;
	lockRetryBaseDelayMs: number;
	lockRetryMaxDelayMs: number;
	lockMode: "wait" | "nowait";
}
