// =============================================================================
// CQRS ADAPTER — Read/Write path separation
// =============================================================================
// Simple wrapper that holds separate adapters for reads and writes.
// Reads go to a read replica, writes go to the primary.

import type { CQRSAdapter, CQRSAdapterOptions } from "./types.js";

/**
 * Create a CQRS adapter pair for separating read and write paths.
 *
 * @example
 * ```ts
 * import { createCQRSAdapter } from "@summa-ledger/projections";
 *
 * const cqrs = createCQRSAdapter({
 *   readAdapter: replicaAdapter,   // connected to read replica
 *   writeAdapter: primaryAdapter,  // connected to primary
 * });
 *
 * // Use cqrs.read for queries, cqrs.write for mutations
 * ```
 */
export function createCQRSAdapter(options: CQRSAdapterOptions): CQRSAdapter {
	return {
		read: options.readAdapter,
		write: options.writeAdapter,
	};
}
