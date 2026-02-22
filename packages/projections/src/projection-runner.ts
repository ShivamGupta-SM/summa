// =============================================================================
// PROJECTION RUNNER — Plugin factory for CQRS projections
// =============================================================================
// Creates a SummaPlugin that runs one worker per projection.
// Each worker consumes events from a Redis Streams topic, processes them
// through the projection's handleEvent(), and ACKs on success.
//
// A dedicated publisher worker reads new events from ledger_event and
// publishes them to Redis Streams. Watermark tracked in projection_watermark table.

import type {
	StoredEvent,
	SummaContext,
	SummaPlugin,
	SummaWorkerDefinition,
	TableDefinition,
} from "@summa/core";
import { createTableResolver } from "@summa/core/db";
import type { MessageBus } from "@summa/message-queue";
import type { Projection, ProjectionRunnerOptions } from "./types.js";

// =============================================================================
// SCHEMA — watermark tracking table
// =============================================================================

const projectionSchema: Record<string, TableDefinition> = {
	projection_watermark: {
		columns: {
			id: { type: "text", primaryKey: true, notNull: true },
			last_sequence: { type: "bigint", notNull: true, default: "0" },
			updated_at: { type: "timestamp", notNull: true, default: "NOW()" },
		},
	},
};

// =============================================================================
// PLUGIN FACTORY
// =============================================================================

export function projectionRunner(
	bus: MessageBus,
	projections: Projection[],
	options?: ProjectionRunnerOptions,
): SummaPlugin {
	const topic = options?.topic ?? "summa:events";
	const group = options?.group ?? "projection-runner";
	const consumer = options?.consumer ?? `proj-${process.pid}`;
	const batchSize = options?.batchSize ?? 100;
	const pollInterval = options?.pollInterval ?? "5s";
	const pendingClaimAfterMs = options?.pendingClaimAfterMs ?? 30_000;

	// Create workers — one per projection for isolation + one publisher
	const workers: SummaWorkerDefinition[] = [
		// Publisher worker: reads new events from DB and publishes to stream
		{
			id: "projection-publisher",
			description: "Publish new ledger events to Redis Streams for projections",
			interval: pollInterval,
			leaseRequired: true,
			handler: async (ctx: SummaContext) => {
				await publishNewEvents(bus, topic, batchSize, ctx);
			},
		},
		// Per-projection consumer workers
		...projections.map((proj) => ({
			id: `projection-${proj.id}`,
			description: proj.description ?? `Projection: ${proj.id}`,
			interval: pollInterval,
			leaseRequired: false,
			handler: async (ctx: SummaContext) => {
				await pollOnce(
					bus,
					topic,
					group,
					`${consumer}-${proj.id}`,
					batchSize,
					pendingClaimAfterMs,
					proj,
					ctx,
				);
			},
		})),
	];

	return {
		id: "projection-runner",

		dependencies: [],

		schema: projectionSchema,

		init: async (ctx: SummaContext) => {
			// Ensure consumer group exists
			await bus.ensureGroup(topic, group);

			// Run projection init hooks
			for (const proj of projections) {
				if (proj.init) {
					await proj.init(ctx);
				}
			}
		},

		workers,
	};
}

// =============================================================================
// EVENT PUBLISHER — DB to Redis Streams
// =============================================================================

async function publishNewEvents(
	bus: MessageBus,
	topic: string,
	batchSize: number,
	ctx: SummaContext,
): Promise<void> {
	const t = createTableResolver(ctx.options.schema);

	// Read current watermark
	const watermarkRows = await ctx.adapter.raw<{ last_sequence: number }>(
		`SELECT last_sequence FROM ${t("projection_watermark")} WHERE id = 'publisher' LIMIT 1`,
		[],
	);
	const watermark = watermarkRows[0] ? Number(watermarkRows[0].last_sequence) : 0;

	// Find events since watermark
	const newEvents = await ctx.adapter.raw<{
		id: string;
		sequence_number: number;
		aggregate_type: string;
		aggregate_id: string;
		aggregate_version: number;
		event_type: string;
		event_data: Record<string, unknown>;
		correlation_id: string;
		hash: string;
		prev_hash: string | null;
		created_at: string | Date;
		ledger_id: string;
	}>(
		`SELECT id, sequence_number, aggregate_type, aggregate_id, aggregate_version,
		        event_type, event_data, correlation_id, hash, prev_hash, created_at, ledger_id
		 FROM ${t("ledger_event")}
		 WHERE sequence_number > $1
		 ORDER BY sequence_number ASC
		 LIMIT $2`,
		[watermark, batchSize],
	);

	if (newEvents.length === 0) return;

	let maxSeq = watermark;
	for (const event of newEvents) {
		const seq = Number(event.sequence_number);
		try {
			await bus.publish(topic, {
				id: event.id,
				sequenceNumber: seq,
				aggregateType: event.aggregate_type,
				aggregateId: event.aggregate_id,
				aggregateVersion: Number(event.aggregate_version),
				eventType: event.event_type,
				eventData: event.event_data,
				correlationId: event.correlation_id,
				hash: event.hash,
				prevHash: event.prev_hash,
				createdAt:
					event.created_at instanceof Date ? event.created_at.toISOString() : event.created_at,
				ledgerId: event.ledger_id,
			});
			if (seq > maxSeq) maxSeq = seq;
		} catch {
			// Best effort — events will be published on next poll
			break;
		}
	}

	// Update watermark
	if (maxSeq > watermark) {
		await ctx.adapter.rawMutate(
			`INSERT INTO ${t("projection_watermark")} (id, last_sequence, updated_at)
			 VALUES ('publisher', $1, NOW())
			 ON CONFLICT (id)
			 DO UPDATE SET last_sequence = $1, updated_at = NOW()`,
			[maxSeq],
		);
	}
}

// =============================================================================
// POLL HELPER — Consumer side
// =============================================================================

async function pollOnce(
	bus: MessageBus,
	topic: string,
	group: string,
	consumer: string,
	batchSize: number,
	pendingClaimAfterMs: number,
	projection: Projection,
	ctx: SummaContext,
): Promise<void> {
	const handle = await bus.subscribe(
		topic,
		{
			group,
			consumer,
			batchSize,
			blockMs: 0, // Non-blocking — worker runner controls timing
			pendingClaimAfterMs,
		},
		async (message) => {
			const event = messageToStoredEvent(message.payload);
			if (!event) return;

			// Only process events this projection cares about
			if (!projection.eventTypes.includes(event.eventType)) return;

			// Process in a transaction for atomicity
			await ctx.adapter.transaction(async (tx) => {
				await projection.handleEvent(event, tx, ctx);
			});
		},
	);

	// Let one poll cycle complete, then stop
	// blockMs: 0 ensures this returns immediately if no messages
	await sleep(100);
	await handle.stop();
}

function messageToStoredEvent(payload: Record<string, unknown>): StoredEvent | null {
	if (typeof payload.id !== "string" || typeof payload.eventType !== "string") {
		return null;
	}

	return {
		id: payload.id as string,
		sequenceNumber: Number(payload.sequenceNumber ?? 0),
		aggregateType: String(payload.aggregateType ?? ""),
		aggregateId: String(payload.aggregateId ?? ""),
		aggregateVersion: Number(payload.aggregateVersion ?? 0),
		eventType: payload.eventType as string,
		eventData: (payload.eventData ?? {}) as Record<string, unknown>,
		correlationId: String(payload.correlationId ?? ""),
		hash: String(payload.hash ?? ""),
		prevHash: (payload.prevHash as string | null) ?? null,
		createdAt: payload.createdAt ? new Date(String(payload.createdAt)) : new Date(),
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
