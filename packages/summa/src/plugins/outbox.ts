// =============================================================================
// OUTBOX PLUGIN -- Reliable event delivery from outbox table
// =============================================================================
// Processes pending outbox entries, publishes via user-provided publisher,
// handles retries with dead-letter queue, and cleans up old entries.

import type { SummaContext, SummaPlugin } from "@summa/core";

// =============================================================================
// OPTIONS
// =============================================================================

export interface OutboxOptions {
	/** User-provided publisher function. Receives topic name and payload. */
	publisher: (topic: string, payload: Record<string, unknown>) => Promise<void>;
	/** Max items per batch. Default: 100 */
	batchSize?: number;
	/** Max retry attempts before DLQ. Default: 3 */
	maxRetries?: number;
	/** Retention hours for processed entries. Default: 48 */
	retentionHours?: number;
}

// =============================================================================
// STATS
// =============================================================================

export interface OutboxStats {
	pending: number;
	processed: number;
	failed: number;
}

// =============================================================================
// PLUGIN FACTORY
// =============================================================================

export function outbox(options: OutboxOptions): SummaPlugin {
	const batchSize = options.batchSize ?? 100;
	const maxRetries = options.maxRetries ?? 3;
	const retentionHours = options.retentionHours ?? 48;

	return {
		id: "outbox",

		workers: [
			{
				id: "outbox-processor",
				description:
					"Polls outbox for pending events, publishes via user publisher, handles retries and DLQ",
				interval: "5s",
				leaseRequired: false,
				handler: async (ctx: SummaContext) => {
					const count = await processOutboxBatch(ctx, {
						publisher: options.publisher,
						batchSize,
						maxRetries,
					});
					if (count > 0) {
						ctx.logger.info("Outbox batch processed", { count });
					}
				},
			},
			{
				id: "outbox-cleanup",
				description: "Deletes processed outbox entries older than retention period",
				interval: "6h",
				leaseRequired: true,
				handler: async (ctx: SummaContext) => {
					const deleted = await cleanupProcessedOutbox(ctx, retentionHours);
					if (deleted > 0) {
						ctx.logger.info("Outbox cleanup completed", { deleted, retentionHours });
					}
				},
			},
		],
	};
}

// =============================================================================
// PROCESS OUTBOX BATCH
// =============================================================================

interface RawOutboxRow {
	id: string;
	topic: string;
	payload: Record<string, unknown> | string;
	retry_count: number;
	created_at: string | Date;
}

async function processOutboxBatch(
	ctx: SummaContext,
	options: {
		publisher: (topic: string, payload: Record<string, unknown>) => Promise<void>;
		batchSize: number;
		maxRetries: number;
	},
): Promise<number> {
	let processed = 0;

	await ctx.adapter.transaction(async (tx) => {
		// Select pending outbox entries with row-level locking, skipping already-locked rows
		const rows = await tx.raw<RawOutboxRow>(
			`SELECT id, topic, payload, retry_count, created_at
       FROM outbox
       WHERE processed_at IS NULL
         AND retry_count < $1
       ORDER BY created_at ASC
       LIMIT $2
       FOR UPDATE SKIP LOCKED`,
			[options.maxRetries, options.batchSize],
		);

		if (rows.length === 0) {
			return;
		}

		for (const row of rows) {
			const payload: Record<string, unknown> =
				typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;

			try {
				// Insert into processed_event for deduplication (idempotent via ON CONFLICT)
				const insertedRows = await tx.raw<{ id: string }>(
					`INSERT INTO processed_event (id, topic, payload, processed_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (id) DO NOTHING
           RETURNING id`,
					[row.id, row.topic, JSON.stringify(payload)],
				);

				// If no row returned, this event was already processed (duplicate)
				if (insertedRows.length === 0) {
					// Mark outbox entry as processed to prevent re-processing
					await tx.rawMutate(
						`UPDATE outbox
             SET processed_at = NOW(), status = 'processed'
             WHERE id = $1`,
						[row.id],
					);
					processed++;
					continue;
				}

				// Publish via user-provided publisher
				await options.publisher(row.topic, payload);

				// Mark outbox entry as processed
				await tx.rawMutate(
					`UPDATE outbox
           SET processed_at = NOW(), status = 'processed'
           WHERE id = $1`,
					[row.id],
				);

				processed++;
			} catch (error) {
				const newRetryCount = Number(row.retry_count) + 1;
				const errorMessage = error instanceof Error ? error.message : String(error);

				if (newRetryCount >= options.maxRetries) {
					// Max retries exceeded -- move to dead letter queue
					await tx.raw(
						`INSERT INTO dead_letter_queue (outbox_id, topic, payload, error_message, retry_count)
             VALUES ($1, $2, $3, $4, $5)`,
						[row.id, row.topic, JSON.stringify(payload), errorMessage, newRetryCount],
					);

					await tx.rawMutate(
						`UPDATE outbox
             SET retry_count = $1, status = 'failed', last_error = $2
             WHERE id = $3`,
						[newRetryCount, errorMessage, row.id],
					);

					ctx.logger.info("Outbox entry moved to dead letter queue", {
						outboxId: row.id,
						topic: row.topic,
						retryCount: newRetryCount,
						error: errorMessage,
					});
				} else {
					// Increment retry count for next attempt
					await tx.rawMutate(
						`UPDATE outbox
             SET retry_count = $1, last_error = $2
             WHERE id = $3`,
						[newRetryCount, errorMessage, row.id],
					);
				}
			}
		}
	});

	return processed;
}

// =============================================================================
// CLEANUP PROCESSED OUTBOX
// =============================================================================

async function cleanupProcessedOutbox(ctx: SummaContext, retentionHours: number): Promise<number> {
	const deleted = await ctx.adapter.rawMutate(
		`DELETE FROM outbox
     WHERE processed_at IS NOT NULL
       AND status = 'processed'
       AND processed_at < NOW() - INTERVAL '1 hour' * $1`,
		[retentionHours],
	);

	return deleted;
}

// =============================================================================
// GET OUTBOX STATS
// =============================================================================

export async function getOutboxStats(ctx: SummaContext): Promise<OutboxStats> {
	const rows = await ctx.adapter.raw<{
		status: string;
		count: number;
	}>(
		`SELECT
       CASE
         WHEN processed_at IS NULL AND retry_count < 3 THEN 'pending'
         WHEN status = 'processed' THEN 'processed'
         ELSE 'failed'
       END AS status,
       COUNT(*)::int AS count
     FROM outbox
     GROUP BY 1`,
		[],
	);

	const stats: OutboxStats = { pending: 0, processed: 0, failed: 0 };

	for (const row of rows) {
		if (row.status === "pending") stats.pending = Number(row.count);
		else if (row.status === "processed") stats.processed = Number(row.count);
		else if (row.status === "failed") stats.failed = Number(row.count);
	}

	return stats;
}
