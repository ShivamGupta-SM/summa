// =============================================================================
// PROJECTION TYPES
// =============================================================================
// Interfaces for defining and running CQRS projections.
// Projections consume events from a MessageBus and maintain denormalized
// read models in separate tables.

import type { StoredEvent, SummaContext } from "@summa-ledger/core";
import type { SummaTransactionAdapter } from "@summa-ledger/core/db";

// =============================================================================
// PROJECTION
// =============================================================================

/**
 * A projection defines how events are mapped to a read model table.
 * Each projection handles specific event types and maintains its own state.
 */
export interface Projection {
	/** Unique identifier for this projection. */
	id: string;
	/** Human-readable description. */
	description?: string;
	/** Event types this projection handles (e.g., ["TransactionPosted", "AccountCreated"]). */
	eventTypes: string[];
	/** Optional initialization hook — runs once when the projection runner starts. */
	init?: (ctx: SummaContext) => Promise<void>;
	/** Process a single event within a transaction. Must be idempotent. */
	handleEvent(event: StoredEvent, tx: SummaTransactionAdapter, ctx: SummaContext): Promise<void>;
}

// =============================================================================
// PROJECTION RUNNER OPTIONS
// =============================================================================

export interface ProjectionRunnerOptions {
	/** Redis Streams topic to consume events from. Default: "summa:events" */
	topic?: string;
	/** Consumer group name. Default: "projection-runner" */
	group?: string;
	/** Consumer name (unique per process). Default: auto-generated from hostname + pid */
	consumer?: string;
	/** Max messages per poll. Default: 100 */
	batchSize?: number;
	/** How often each projection worker polls for messages. Default: "5s" */
	pollInterval?: string;
	/** Reclaim pending messages idle longer than this (ms). Default: 30_000 */
	pendingClaimAfterMs?: number;
}

// =============================================================================
// CQRS ADAPTER
// =============================================================================

export interface CQRSAdapterOptions {
	/** Adapter for read operations (e.g., connected to read replica). */
	readAdapter: import("@summa-ledger/core/db").SummaAdapter;
	/** Adapter for write operations (e.g., connected to primary). */
	writeAdapter: import("@summa-ledger/core/db").SummaAdapter;
}

export interface CQRSAdapter {
	read: import("@summa-ledger/core/db").SummaAdapter;
	write: import("@summa-ledger/core/db").SummaAdapter;
}
