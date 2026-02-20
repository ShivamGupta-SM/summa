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
	SummaPlugin,
	SystemAccountDefinition,
} from "@summa/core";
import { SummaError } from "@summa/core";
import { postgresDialect } from "@summa/core/db";
import { createConsoleLogger } from "@summa/core/logger";
import { validateConfig } from "../config/index.js";

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
	// Runtime config validation
	validateConfig(options);

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

	// Validate and sort plugins by dependencies
	const plugins = sortPlugins(options.plugins ?? []);

	return {
		adapter,
		dialect,
		options: resolvedOptions,
		logger,
		plugins,
	};
}

// =============================================================================
// PLUGIN DEPENDENCY VALIDATION & TOPOLOGICAL SORT
// =============================================================================

function sortPlugins(plugins: SummaPlugin[]): SummaPlugin[] {
	if (plugins.length <= 1) return plugins;

	const pluginMap = new Map<string, SummaPlugin>();
	for (const plugin of plugins) {
		pluginMap.set(plugin.id, plugin);
	}

	// Validate all dependencies exist
	for (const plugin of plugins) {
		if (!plugin.dependencies) continue;
		for (const dep of plugin.dependencies) {
			if (!pluginMap.has(dep)) {
				throw SummaError.invalidArgument(
					`Plugin "${plugin.id}" requires plugin "${dep}" which is not registered`,
				);
			}
		}
	}

	// Kahn's algorithm for topological sort
	const inDegree = new Map<string, number>();
	const adj = new Map<string, string[]>();

	for (const plugin of plugins) {
		inDegree.set(plugin.id, 0);
		adj.set(plugin.id, []);
	}

	for (const plugin of plugins) {
		if (!plugin.dependencies) continue;
		for (const dep of plugin.dependencies) {
			const neighbors = adj.get(dep);
			if (neighbors) neighbors.push(plugin.id);
			inDegree.set(plugin.id, (inDegree.get(plugin.id) ?? 0) + 1);
		}
	}

	const queue: string[] = [];
	for (const [id, deg] of inDegree) {
		if (deg === 0) queue.push(id);
	}

	const sorted: SummaPlugin[] = [];
	while (queue.length > 0) {
		const id = queue.shift() as string;
		const plugin = pluginMap.get(id);
		if (plugin) sorted.push(plugin);
		for (const neighbor of adj.get(id) ?? []) {
			const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
			inDegree.set(neighbor, newDeg);
			if (newDeg === 0) queue.push(neighbor);
		}
	}

	if (sorted.length !== plugins.length) {
		// Find cycle participants for error message
		const unsorted = plugins.filter((p) => !sorted.includes(p)).map((p) => p.id);
		throw SummaError.invalidArgument(
			`Circular plugin dependency detected among: ${unsorted.join(", ")}`,
		);
	}

	return sorted;
}
