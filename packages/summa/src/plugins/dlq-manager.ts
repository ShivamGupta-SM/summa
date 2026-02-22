// =============================================================================
// DLQ MANAGER PLUGIN
// =============================================================================
// Manages dead letter queue entries — retry, resolve, list, and stats.
// Ported from the original Encore ledger's subscribers/dlq-handler.ts.

import type {
	PaginatedResult,
	SummaContext,
	SummaPlugin,
	TableDefinition,
} from "@summa-ledger/core";
import { createTableResolver } from "@summa-ledger/core/db";

// =============================================================================
// TYPES
// =============================================================================

export interface DlqManagerOptions {
	/** Max items to display in stats. Default: 100 */
	maxDisplayItems?: number;
	/** Auto-retry interval. Default: "30m" */
	retryInterval?: string;
	/** Max auto-retry attempts. Default: 3 */
	maxAutoRetries?: number;
}

export interface DlqStats {
	totalUnresolved: number;
	totalResolved: number;
	byTopic: Record<string, number>;
	oldestUnresolved: string | null;
}

export interface FailedEvent {
	id: string;
	outbox_id: string;
	topic: string;
	payload: Record<string, unknown>;
	error_message: string;
	retry_count: number;
	resolved_at: string | null;
	resolved_by: string | null;
	created_at: string;
}

// =============================================================================
// SCHEMA
// =============================================================================

const dlqSchema: Record<string, TableDefinition> = {
	deadLetterQueue: {
		columns: {
			id: { type: "uuid", primaryKey: true, notNull: true },
			outbox_id: { type: "uuid", notNull: true },
			topic: { type: "text", notNull: true },
			payload: { type: "jsonb", notNull: true },
			error_message: { type: "text", notNull: true },
			retry_count: { type: "integer", notNull: true, default: "0" },
			resolved_at: { type: "timestamp" },
			resolved_by: { type: "text" },
			created_at: { type: "timestamp", notNull: true, default: "NOW()" },
		},
		indexes: [
			{ name: "idx_dlq_topic", columns: ["topic"] },
			{ name: "idx_dlq_unresolved", columns: ["resolved_at"] },
		],
	},
};

// =============================================================================
// PLUGIN FACTORY
// =============================================================================

export function dlqManager(options?: DlqManagerOptions): SummaPlugin {
	const maxAutoRetries = options?.maxAutoRetries ?? 3;

	return {
		id: "dlq-manager",

		$Infer: {} as { FailedEvent: FailedEvent; DlqStats: DlqStats },

		schema: dlqSchema,

		workers: [
			{
				id: "dlq-auto-retry",
				description: "Automatically retry DLQ entries that haven't exceeded max retries",
				handler: async (ctx: SummaContext) => {
					const t = createTableResolver(ctx.options.schema);
					const retryable = await ctx.adapter.raw<FailedEvent>(
						`SELECT * FROM ${t("dead_letter_queue")}
						 WHERE resolved_at IS NULL AND retry_count < $1
						 ORDER BY created_at ASC
						 LIMIT 50`,
						[maxAutoRetries],
					);

					if (retryable.length === 0) return;

					ctx.logger.info("DLQ auto-retry: processing entries", { count: retryable.length });

					for (const entry of retryable) {
						try {
							// Re-insert into outbox for reprocessing
							await ctx.adapter.rawMutate(
								`INSERT INTO ${t("outbox")} (id, topic, payload, status, created_at)
								 VALUES (${ctx.dialect.generateUuid()}, $1, $2, 'pending', ${ctx.dialect.now()})`,
								[entry.topic, JSON.stringify(entry.payload)],
							);

							// Increment retry count
							await ctx.adapter.rawMutate(
								`UPDATE ${t("dead_letter_queue")} SET retry_count = retry_count + 1 WHERE id = $1`,
								[entry.id],
							);

							ctx.logger.info("DLQ entry requeued", { id: entry.id, topic: entry.topic });
						} catch (err) {
							ctx.logger.error("DLQ auto-retry failed", {
								id: entry.id,
								error: String(err),
							});
						}
					}
				},
				interval: options?.retryInterval ?? "30m",
				leaseRequired: true,
			},
		],
	};
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/** Get DLQ statistics */
export async function getDlqStats(ctx: SummaContext): Promise<DlqStats> {
	const t = createTableResolver(ctx.options.schema);
	const [unresolvedRows, resolvedRows, topicRows, oldestRows] = await Promise.all([
		ctx.adapter.raw<{ cnt: string }>(
			`SELECT COUNT(*) as cnt FROM ${t("dead_letter_queue")} WHERE resolved_at IS NULL`,
			[],
		),
		ctx.adapter.raw<{ cnt: string }>(
			`SELECT COUNT(*) as cnt FROM ${t("dead_letter_queue")} WHERE resolved_at IS NOT NULL`,
			[],
		),
		ctx.adapter.raw<{ topic: string; cnt: string }>(
			`SELECT topic, COUNT(*) as cnt FROM ${t("dead_letter_queue")}
			 WHERE resolved_at IS NULL
			 GROUP BY topic ORDER BY cnt DESC`,
			[],
		),
		ctx.adapter.raw<{ created_at: string }>(
			`SELECT created_at FROM ${t("dead_letter_queue")}
			 WHERE resolved_at IS NULL
			 ORDER BY created_at ASC LIMIT 1`,
			[],
		),
	]);

	const byTopic: Record<string, number> = {};
	for (const row of topicRows) {
		byTopic[row.topic] = Number(row.cnt);
	}

	return {
		totalUnresolved: Number(unresolvedRows[0]?.cnt ?? 0),
		totalResolved: Number(resolvedRows[0]?.cnt ?? 0),
		byTopic,
		oldestUnresolved: oldestRows[0]?.created_at ?? null,
	};
}

/** List unresolved DLQ events with pagination */
export async function listUnresolvedEvents(
	ctx: SummaContext,
	params?: { page?: number; perPage?: number; topic?: string },
): Promise<PaginatedResult<FailedEvent>> {
	const t = createTableResolver(ctx.options.schema);
	const page = params?.page ?? 1;
	const perPage = params?.perPage ?? 20;
	const offset = (page - 1) * perPage;

	const topicFilter = params?.topic ? "AND topic = $3" : "";
	const queryParams: unknown[] = [perPage, offset];
	if (params?.topic) queryParams.push(params.topic);

	const [rows, countRows] = await Promise.all([
		ctx.adapter.raw<FailedEvent>(
			`SELECT * FROM ${t("dead_letter_queue")}
			 WHERE resolved_at IS NULL ${topicFilter}
			 ORDER BY created_at DESC
			 LIMIT $1 OFFSET $2`,
			queryParams,
		),
		ctx.adapter.raw<{ cnt: string }>(
			`SELECT COUNT(*) as cnt FROM ${t("dead_letter_queue")}
			 WHERE resolved_at IS NULL ${topicFilter}`,
			params?.topic ? [params.topic] : [],
		),
	]);

	const total = Number(countRows[0]?.cnt ?? 0);

	return {
		data: rows,
		total,
		hasMore: offset + rows.length < total,
	};
}

/** Manually retry a specific DLQ event */
export async function retryEvent(ctx: SummaContext, eventId: string): Promise<void> {
	const t = createTableResolver(ctx.options.schema);
	const rows = await ctx.adapter.raw<FailedEvent>(
		`SELECT * FROM ${t("dead_letter_queue")} WHERE id = $1 AND resolved_at IS NULL`,
		[eventId],
	);

	if (rows.length === 0) {
		throw new Error(`DLQ event ${eventId} not found or already resolved`);
	}

	const entry = rows[0]!;

	await ctx.adapter.rawMutate(
		`INSERT INTO ${t("outbox")} (id, topic, payload, status, created_at)
		 VALUES (${ctx.dialect.generateUuid()}, $1, $2, 'pending', ${ctx.dialect.now()})`,
		[entry.topic, JSON.stringify(entry.payload)],
	);

	await ctx.adapter.rawMutate(
		`UPDATE ${t("dead_letter_queue")} SET retry_count = retry_count + 1 WHERE id = $1`,
		[eventId],
	);

	ctx.logger.info("DLQ event manually retried", { id: eventId, topic: entry.topic });
}

/** Mark a DLQ event as resolved */
export async function resolveEvent(
	ctx: SummaContext,
	params: { eventId: string; resolvedBy: string },
): Promise<void> {
	const t = createTableResolver(ctx.options.schema);
	const updated = await ctx.adapter.rawMutate(
		`UPDATE ${t("dead_letter_queue")}
		 SET resolved_at = ${ctx.dialect.now()}, resolved_by = $2
		 WHERE id = $1 AND resolved_at IS NULL`,
		[params.eventId, params.resolvedBy],
	);

	if (updated === 0) {
		throw new Error(`DLQ event ${params.eventId} not found or already resolved`);
	}

	ctx.logger.info("DLQ event resolved", {
		id: params.eventId,
		resolvedBy: params.resolvedBy,
	});
}
