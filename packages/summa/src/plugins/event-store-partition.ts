// =============================================================================
// EVENT STORE PARTITIONING PLUGIN
// =============================================================================
// Thin wrapper around the existing partitionMaintenance() utility, pre-configured
// for the entry table. Creates future partitions automatically and
// optionally detaches old ones.
//
// Users must run the initial partition migration DDL separately (one-time).
// Use the CLI command: npx summa partition generate

import type { SummaPlugin } from "@summa-ledger/core";
import { type PartitionInterval, partitionMaintenance } from "../db/partitioning.js";

// =============================================================================
// TYPES
// =============================================================================

export interface EventStorePartitionOptions {
	/** Partition interval. Default: "monthly" */
	interval?: Extract<PartitionInterval, "monthly" | "weekly">;

	/** Create partitions this many intervals ahead. Default: 3 */
	createAhead?: number;

	/** Detach partitions older than this many intervals. Null = never detach. Default: null */
	retainPartitions?: number | null;

	/** PostgreSQL schema. Default: "summa" */
	schema?: string;
}

// =============================================================================
// PLUGIN
// =============================================================================

/**
 * Plugin that automatically creates future partitions for the entry table
 * and optionally detaches old ones.
 *
 * @example
 * ```ts
 * import { eventStorePartition } from "@summa-ledger/summa/plugins";
 *
 * const summa = createSumma({
 *   plugins: [eventStorePartition({ interval: "monthly", createAhead: 3 })],
 * });
 * ```
 */
export function eventStorePartition(options?: EventStorePartitionOptions): SummaPlugin {
	return partitionMaintenance({
		tables: {
			entry: { interval: options?.interval ?? "monthly" },
		},
		createAhead: options?.createAhead ?? 3,
		retainPartitions: options?.retainPartitions ?? null,
		workerInterval: "1d",
		schema: options?.schema,
	});
}
