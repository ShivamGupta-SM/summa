// =============================================================================
// CONTEXT BUILDER
// =============================================================================
// Builds SummaContext from SummaOptions. Resolves adapter, logger, merges
// config defaults.

import type {
	ResolvedAdvancedOptions,
	ResolvedSummaOptions,
	SummaAdapter,
	SummaContext,
	SummaLogger,
	SummaOptions,
	SystemAccountDefinition,
} from "@summa/core";

// =============================================================================
// DEFAULT LOGGER (console-based)
// =============================================================================

const defaultLogger: SummaLogger = {
	info(_message: string, _data?: Record<string, unknown>) {},
	warn(_message: string, _data?: Record<string, unknown>) {},
	error(_message: string, _data?: Record<string, unknown>) {},
	debug(_message: string, _data?: Record<string, unknown>) {},
};

// =============================================================================
// DEFAULT CONFIG VALUES
// =============================================================================

const DEFAULT_ADVANCED: ResolvedAdvancedOptions = {
	hotAccountThreshold: 1000,
	idempotencyTTL: 24 * 60 * 60 * 1000, // 24 hours in ms
	transactionTimeoutMs: 5000,
	lockTimeoutMs: 3000,
	maxTransactionAmount: 1_000_000_000_00,
	enableEventSourcing: true,
	enableHashChain: true,
};

// =============================================================================
// BUILD CONTEXT
// =============================================================================

export async function buildContext(options: SummaOptions): Promise<SummaContext> {
	// Resolve adapter
	const adapter: SummaAdapter =
		typeof options.database === "function" ? options.database() : options.database;

	// Resolve logger
	const logger: SummaLogger = options.logger ?? defaultLogger;

	// Resolve system accounts — normalize to Record<string, string>
	const systemAccounts: Record<string, string> = { world: "@World" };
	if (options.systemAccounts) {
		for (const [key, value] of Object.entries(options.systemAccounts)) {
			if (typeof value === "string") {
				systemAccounts[key] = value;
			} else {
				systemAccounts[key] = (value as SystemAccountDefinition).identifier;
			}
		}
	}

	// Merge advanced options with defaults
	const advanced: ResolvedAdvancedOptions = {
		...DEFAULT_ADVANCED,
		...(options.advanced ?? {}),
	};

	const resolvedOptions: ResolvedSummaOptions = {
		currency: options.currency ?? "USD",
		systemAccounts,
		advanced,
	};

	return {
		adapter,
		options: resolvedOptions,
		logger,
		plugins: options.plugins ?? [],
	};
}
