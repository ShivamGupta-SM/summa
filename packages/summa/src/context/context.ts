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
	SummaOptions,
	SystemAccountDefinition,
} from "@summa/core";
import { postgresDialect } from "@summa/core/db";
import { createConsoleLogger } from "@summa/core/logger";

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
	const logger = options.logger ?? createConsoleLogger();

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

	// Resolve dialect from adapter options, default to postgres
	const dialect = adapter.options?.dialect ?? postgresDialect;

	return {
		adapter,
		dialect,
		options: resolvedOptions,
		logger,
		plugins: options.plugins ?? [],
	};
}
