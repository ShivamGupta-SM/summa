import type { SummaAdapter } from "../db/adapter.js";
import type { SummaLogger } from "./config.js";
import type { SummaPlugin } from "./plugin.js";

export interface SummaContext {
	adapter: SummaAdapter;
	options: ResolvedSummaOptions;
	logger: SummaLogger;
	plugins: SummaPlugin[];
}

export interface ResolvedSummaOptions {
	currency: string;
	systemAccounts: Record<string, string>;
	advanced: ResolvedAdvancedOptions;
}

export interface ResolvedAdvancedOptions {
	hotAccountThreshold: number;
	idempotencyTTL: number;
	transactionTimeoutMs: number;
	lockTimeoutMs: number;
	maxTransactionAmount: number;
	enableEventSourcing: boolean;
	enableHashChain: boolean;
}
