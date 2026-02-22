// =============================================================================
// OUTBOX PLUGIN -- Reliable event delivery with built-in webhook support
// =============================================================================
// Processes pending outbox entries via user-provided publisher and/or managed
// webhook HTTP delivery. Handles retries, dead-letter queue, HMAC-SHA256
// signing, exponential backoff, and delivery logging.
//
// Architecture (matches Stripe/Convoy pattern):
//   outbox table → publisher function (Kafka, SQS, custom)
//                → webhook delivery engine (HTTP POST with HMAC signing)
//
// Both delivery modes can be used independently or together.

import { createHmac, randomBytes } from "node:crypto";
import type {
	PluginApiRequest,
	PluginApiResponse,
	SummaContext,
	SummaPlugin,
	TableDefinition,
} from "@summa-ledger/core";
import { SummaError, validatePluginOptions } from "@summa-ledger/core";
import { createTableResolver } from "@summa-ledger/core/db";
import { getLedgerId } from "../managers/ledger-helpers.js";

// =============================================================================
// TYPES — Webhook
// =============================================================================

export interface WebhookEndpoint {
	id: string;
	url: string;
	secret: string;
	events: string[];
	active: boolean;
	description: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface WebhookDelivery {
	id: string;
	webhookId: string;
	eventType: string;
	payload: Record<string, unknown>;
	statusCode: number | null;
	responseBody: string | null;
	attempt: number;
	status: "pending" | "delivered" | "failed";
	nextRetryAt: string | null;
	deliveredAt: string | null;
	createdAt: string;
}

export interface WebhookOptions {
	/** HMAC-SHA256 signing secret for outgoing payloads. If omitted, per-endpoint secrets are used. */
	signingSecret?: string;
	/** Max retry attempts per delivery. Default: 5 */
	maxRetries?: number;
	/** Delivery log retention in days. Default: 30 */
	retentionDays?: number;
	/** Custom HTTP headers to include in all webhook deliveries */
	defaultHeaders?: Record<string, string>;
	/** Timeout for webhook HTTP requests in ms. Default: 10000 */
	timeoutMs?: number;
	/** Max concurrent webhook deliveries per worker cycle. Default: 10 */
	concurrency?: number;
}

// =============================================================================
// TYPES — Outbox
// =============================================================================

/** Minimal MessageBus interface — avoids hard dependency on @summa-ledger/message-queue. */
export interface MessageBusLike {
	publish(
		topic: string,
		payload: Record<string, unknown>,
		options?: { maxLen?: number },
	): Promise<string>;
}

export interface StreamPublisherOptions {
	/** Approximate max stream length (MAXLEN ~). Default: 100_000 */
	maxLen?: number;
}

export interface OutboxOptions {
	/** User-provided publisher function. Receives topic name and payload. */
	publisher?: (topic: string, payload: Record<string, unknown>) => Promise<void>;
	/** MessageBus instance (e.g. from @summa-ledger/message-queue). Auto-creates a stream publisher. */
	messageQueue?: MessageBusLike;
	/** Options for the auto-created stream publisher when using messageQueue. */
	streamPublisherOptions?: StreamPublisherOptions;
	/** Managed webhook delivery configuration. */
	webhooks?: WebhookOptions;
	/** Max items per batch. Default: 100 */
	batchSize?: number;
	/** Max retry attempts for publisher before DLQ. Default: 3 */
	maxRetries?: number;
	/** Retention hours for processed entries. Default: 48 */
	retentionHours?: number;
	/** Number of parallel outbox consumer workers. Each uses SKIP LOCKED for natural partitioning. Default: 1 */
	concurrency?: number;
}

export interface OutboxStats {
	pending: number;
	processed: number;
	failed: number;
}

// =============================================================================
// RAW ROWS
// =============================================================================

interface RawOutboxRow {
	id: string;
	topic: string;
	payload: Record<string, unknown> | string;
	retry_count: number;
	created_at: string | Date;
}

interface RawWebhookRow {
	id: string;
	ledger_id: string;
	url: string;
	secret: string;
	events: string[] | string;
	active: boolean;
	description: string | null;
	created_at: string | Date;
	updated_at: string | Date;
}

interface RawDeliveryRow {
	id: string;
	webhook_id: string;
	event_type: string;
	payload: Record<string, unknown> | string;
	status_code: number | null;
	response_body: string | null;
	attempt: number;
	status: string;
	next_retry_at: string | Date | null;
	delivered_at: string | Date | null;
	created_at: string | Date;
}

// =============================================================================
// HELPERS
// =============================================================================

function toIso(val: string | Date | null): string | null {
	if (!val) return null;
	return val instanceof Date ? val.toISOString() : String(val);
}

function toIsoRequired(val: string | Date): string {
	return val instanceof Date ? val.toISOString() : String(val);
}

function rawToWebhook(row: RawWebhookRow): WebhookEndpoint {
	return {
		id: row.id,
		url: row.url,
		secret: row.secret,
		events: typeof row.events === "string" ? JSON.parse(row.events) : row.events,
		active: row.active,
		description: row.description,
		createdAt: toIsoRequired(row.created_at),
		updatedAt: toIsoRequired(row.updated_at),
	};
}

function rawToDelivery(row: RawDeliveryRow): WebhookDelivery {
	return {
		id: row.id,
		webhookId: row.webhook_id,
		eventType: row.event_type,
		payload: typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload,
		statusCode: row.status_code,
		responseBody: row.response_body,
		attempt: row.attempt,
		status: row.status as WebhookDelivery["status"],
		nextRetryAt: toIso(row.next_retry_at),
		deliveredAt: toIso(row.delivered_at),
		createdAt: toIsoRequired(row.created_at),
	};
}

function json(status: number, body: unknown): PluginApiResponse {
	return { status, body };
}

function signPayload(payload: string, secret: string): string {
	return createHmac("sha256", secret).update(payload).digest("hex");
}

function eventMatches(eventType: string, pattern: string): boolean {
	if (pattern === "*") return true;
	if (pattern === eventType) return true;
	if (pattern.endsWith(".*")) {
		const prefix = pattern.slice(0, -2);
		return eventType.startsWith(`${prefix}.`);
	}
	return false;
}

const BACKOFF_SECONDS = [5, 30, 120, 900, 3600];

function getBackoffSeconds(attempt: number): number {
	return BACKOFF_SECONDS[Math.min(attempt, BACKOFF_SECONDS.length - 1)] ?? 3600;
}

// =============================================================================
// WEBHOOK SCHEMA (only added when webhooks are enabled)
// =============================================================================

const webhookSchema: Record<string, TableDefinition> = {
	webhook_endpoint: {
		columns: {
			id: { type: "uuid", primaryKey: true, notNull: true },
			ledger_id: { type: "uuid", notNull: true },
			url: { type: "text", notNull: true },
			secret: { type: "text", notNull: true },
			events: { type: "jsonb", notNull: true },
			active: { type: "boolean", notNull: true, default: "true" },
			description: { type: "text" },
			created_at: { type: "timestamp", notNull: true, default: "NOW()" },
			updated_at: { type: "timestamp", notNull: true, default: "NOW()" },
		},
		indexes: [
			{ name: "idx_webhook_endpoint_ledger", columns: ["ledger_id"] },
			{ name: "idx_webhook_endpoint_active", columns: ["active"] },
		],
	},
	webhook_delivery: {
		columns: {
			id: { type: "uuid", primaryKey: true, notNull: true },
			webhook_id: {
				type: "uuid",
				notNull: true,
				references: { table: "webhook_endpoint", column: "id" },
			},
			event_type: { type: "text", notNull: true },
			payload: { type: "jsonb", notNull: true },
			status_code: { type: "integer" },
			response_body: { type: "text" },
			attempt: { type: "integer", notNull: true, default: "0" },
			status: { type: "text", notNull: true, default: "'pending'" },
			next_retry_at: { type: "timestamp" },
			delivered_at: { type: "timestamp" },
			created_at: { type: "timestamp", notNull: true, default: "NOW()" },
		},
		indexes: [
			{ name: "idx_webhook_delivery_webhook", columns: ["webhook_id"] },
			{ name: "idx_webhook_delivery_status", columns: ["status"] },
			{ name: "idx_webhook_delivery_retry", columns: ["status", "next_retry_at"] },
			{ name: "idx_webhook_delivery_created", columns: ["created_at"] },
		],
	},
};

// =============================================================================
// OUTBOX — CORE OPERATIONS
// =============================================================================

async function processOutboxBatch(
	ctx: SummaContext,
	options: {
		publisher: (topic: string, payload: Record<string, unknown>) => Promise<void>;
		batchSize: number;
		maxRetries: number;
	},
): Promise<number> {
	let processed = 0;

	const t = createTableResolver(ctx.options.schema);

	await ctx.adapter.transaction(async (tx) => {
		const { dialect } = ctx;
		const rows = await tx.raw<RawOutboxRow>(
			`SELECT id, topic, payload, retry_count, created_at
       FROM ${t("outbox")}
       WHERE processed_at IS NULL
         AND retry_count < $1
       ORDER BY created_at ASC
       LIMIT $2
       ${dialect.forUpdateSkipLocked()}`,
			[options.maxRetries, options.batchSize],
		);

		if (rows.length === 0) return;

		for (const row of rows) {
			const payload: Record<string, unknown> =
				typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;

			try {
				const insertedRows = await tx.raw<{ id: string }>(
					`INSERT INTO ${t("processed_event")} (id, topic, payload, processed_at)
           VALUES ($1, $2, $3, ${dialect.now()})
           ${dialect.onConflictDoNothing(["id"])}
           ${dialect.returning(["id"])}`,
					[row.id, row.topic, JSON.stringify(payload)],
				);

				if (insertedRows.length === 0) {
					await tx.rawMutate(
						`UPDATE ${t("outbox")}
             SET processed_at = ${dialect.now()}, status = 'processed'
             WHERE id = $1`,
						[row.id],
					);
					processed++;
					continue;
				}

				await options.publisher(row.topic, payload);

				await tx.rawMutate(
					`UPDATE ${t("outbox")}
           SET processed_at = NOW(), status = 'processed'
           WHERE id = $1`,
					[row.id],
				);

				processed++;
			} catch (error) {
				const newRetryCount = Number(row.retry_count) + 1;
				const errorMessage = error instanceof Error ? error.message : String(error);

				if (newRetryCount >= options.maxRetries) {
					await tx.raw(
						`INSERT INTO ${t("dead_letter_queue")} (outbox_id, topic, payload, error_message, retry_count)
             VALUES ($1, $2, $3, $4, $5)`,
						[row.id, row.topic, JSON.stringify(payload), errorMessage, newRetryCount],
					);

					await tx.rawMutate(
						`UPDATE ${t("outbox")}
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
					await tx.rawMutate(
						`UPDATE ${t("outbox")}
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

async function cleanupProcessedOutbox(ctx: SummaContext, retentionHours: number): Promise<number> {
	const { dialect } = ctx;
	const t = createTableResolver(ctx.options.schema);
	const deleted = await ctx.adapter.rawMutate(
		`DELETE FROM ${t("outbox")}
     WHERE processed_at IS NOT NULL
       AND status = 'processed'
       AND processed_at < ${dialect.now()} - ${dialect.interval("1 hour")} * $1`,
		[retentionHours],
	);

	return deleted;
}

// =============================================================================
// WEBHOOK — CRUD OPERATIONS
// =============================================================================

export async function registerWebhook(
	ctx: SummaContext,
	params: {
		url: string;
		events: string[];
		description?: string;
	},
): Promise<WebhookEndpoint> {
	const t = createTableResolver(ctx.options.schema);
	const d = ctx.dialect;
	const ledgerId = getLedgerId(ctx);
	const secret = `whsec_${randomBytes(24).toString("base64url")}`;

	const rows = await ctx.adapter.raw<RawWebhookRow>(
		`INSERT INTO ${t("webhook_endpoint")} (
			id, ledger_id, url, secret, events, description, created_at, updated_at
		) VALUES (
			${d.generateUuid()}, $1, $2, $3, $4, $5, ${d.now()}, ${d.now()}
		) RETURNING *`,
		[ledgerId, params.url, secret, JSON.stringify(params.events), params.description ?? null],
	);

	const row = rows[0];
	if (!row) throw SummaError.internal("Failed to register webhook");
	return rawToWebhook(row);
}

export async function listWebhooks(
	ctx: SummaContext,
	params?: { activeOnly?: boolean },
): Promise<WebhookEndpoint[]> {
	const t = createTableResolver(ctx.options.schema);
	const ledgerId = getLedgerId(ctx);

	const conditions: string[] = ["ledger_id = $1"];
	const queryParams: unknown[] = [ledgerId];

	if (params?.activeOnly !== false) {
		conditions.push("active = true");
	}

	const rows = await ctx.adapter.raw<RawWebhookRow>(
		`SELECT * FROM ${t("webhook_endpoint")}
		 WHERE ${conditions.join(" AND ")}
		 ORDER BY created_at DESC`,
		queryParams,
	);

	return rows.map(rawToWebhook);
}

export async function updateWebhook(
	ctx: SummaContext,
	webhookId: string,
	params: Partial<{ url: string; events: string[]; active: boolean; description: string }>,
): Promise<WebhookEndpoint> {
	const t = createTableResolver(ctx.options.schema);
	const d = ctx.dialect;
	const ledgerId = getLedgerId(ctx);

	const sets: string[] = [];
	const queryParams: unknown[] = [];
	let idx = 1;

	if (params.url !== undefined) {
		sets.push(`url = $${idx++}`);
		queryParams.push(params.url);
	}
	if (params.events !== undefined) {
		sets.push(`events = $${idx++}`);
		queryParams.push(JSON.stringify(params.events));
	}
	if (params.active !== undefined) {
		sets.push(`active = $${idx++}`);
		queryParams.push(params.active);
	}
	if (params.description !== undefined) {
		sets.push(`description = $${idx++}`);
		queryParams.push(params.description);
	}

	if (sets.length === 0) throw SummaError.invalidArgument("No fields to update");

	sets.push(`updated_at = ${d.now()}`);
	queryParams.push(webhookId, ledgerId);

	const rows = await ctx.adapter.raw<RawWebhookRow>(
		`UPDATE ${t("webhook_endpoint")} SET ${sets.join(", ")}
		 WHERE id = $${idx++} AND ledger_id = $${idx}
		 RETURNING *`,
		queryParams,
	);

	const row = rows[0];
	if (!row) throw SummaError.notFound("Webhook not found");
	return rawToWebhook(row);
}

export async function deleteWebhook(ctx: SummaContext, webhookId: string): Promise<void> {
	const t = createTableResolver(ctx.options.schema);
	const ledgerId = getLedgerId(ctx);

	await ctx.adapter.rawMutate(`DELETE FROM ${t("webhook_delivery")} WHERE webhook_id = $1`, [
		webhookId,
	]);

	const deleted = await ctx.adapter.rawMutate(
		`DELETE FROM ${t("webhook_endpoint")} WHERE id = $1 AND ledger_id = $2`,
		[webhookId, ledgerId],
	);

	if (deleted === 0) throw SummaError.notFound("Webhook not found");
}

export async function getDeliveryLog(
	ctx: SummaContext,
	webhookId: string,
	params?: { page?: number; perPage?: number; status?: string },
): Promise<{ deliveries: WebhookDelivery[]; hasMore: boolean }> {
	const t = createTableResolver(ctx.options.schema);
	const page = Math.max(1, params?.page ?? 1);
	const perPage = Math.min(params?.perPage ?? 20, 100);
	const offset = (page - 1) * perPage;

	const conditions: string[] = ["webhook_id = $1"];
	const queryParams: unknown[] = [webhookId];
	let idx = 2;

	if (params?.status) {
		conditions.push(`status = $${idx++}`);
		queryParams.push(params.status);
	}

	queryParams.push(perPage + 1, offset);

	const rows = await ctx.adapter.raw<RawDeliveryRow>(
		`SELECT * FROM ${t("webhook_delivery")}
		 WHERE ${conditions.join(" AND ")}
		 ORDER BY created_at DESC
		 LIMIT $${idx++} OFFSET $${idx}`,
		queryParams,
	);

	const hasMore = rows.length > perPage;
	const deliveries = (hasMore ? rows.slice(0, perPage) : rows).map(rawToDelivery);
	return { deliveries, hasMore };
}

// =============================================================================
// WEBHOOK — DELIVERY ENGINE
// =============================================================================

async function processWebhookDeliveries(
	ctx: SummaContext,
	opts: {
		maxRetries: number;
		timeoutMs: number;
		defaultHeaders?: Record<string, string>;
		concurrency?: number;
	},
): Promise<number> {
	const t = createTableResolver(ctx.options.schema);
	const d = ctx.dialect;
	const maxConcurrency = opts.concurrency ?? 10;

	const rows = await ctx.adapter.raw<RawDeliveryRow>(
		`SELECT * FROM ${t("webhook_delivery")}
		 WHERE status = 'pending'
		   AND (next_retry_at IS NULL OR next_retry_at <= ${d.now()})
		   AND attempt < $1
		 ORDER BY created_at ASC
		 LIMIT 50`,
		[opts.maxRetries],
	);

	if (rows.length === 0) return 0;

	// Process deliveries in parallel with concurrency limit
	let delivered = 0;
	const semaphore = { active: 0, queue: [] as (() => void)[] };

	async function withConcurrency<T>(fn: () => Promise<T>): Promise<T> {
		while (semaphore.active >= maxConcurrency) {
			await new Promise<void>((resolve) => semaphore.queue.push(resolve));
		}
		semaphore.active++;
		try {
			return await fn();
		} finally {
			semaphore.active--;
			const next = semaphore.queue.shift();
			if (next) next();
		}
	}

	const results = await Promise.allSettled(
		rows.map((row) => withConcurrency(() => deliverSingleWebhook(ctx, row, opts))),
	);

	for (const result of results) {
		if (result.status === "fulfilled" && result.value) delivered++;
	}

	return delivered;
}

/** Deliver a single webhook. Returns true if delivered successfully. */
async function deliverSingleWebhook(
	ctx: SummaContext,
	row: RawDeliveryRow,
	opts: { maxRetries: number; timeoutMs: number; defaultHeaders?: Record<string, string> },
): Promise<boolean> {
	const t = createTableResolver(ctx.options.schema);
	const d = ctx.dialect;

	const webhookRows = await ctx.adapter.raw<RawWebhookRow>(
		`SELECT * FROM ${t("webhook_endpoint")} WHERE id = $1 AND active = true`,
		[row.webhook_id],
	);

	const webhook = webhookRows[0];
	if (!webhook) {
		await ctx.adapter.rawMutate(
			`UPDATE ${t("webhook_delivery")} SET status = 'failed' WHERE id = $1`,
			[row.id],
		);
		return false;
	}

	const payload = typeof row.payload === "string" ? row.payload : JSON.stringify(row.payload);
	const signature = signPayload(payload, webhook.secret);
	const timestamp = new Date().toISOString();
	const attempt = Number(row.attempt) + 1;

	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), opts.timeoutMs);

		const response = await fetch(webhook.url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Summa-Signature": signature,
				"X-Summa-Event": row.event_type,
				"X-Summa-Delivery-Id": row.id,
				"X-Summa-Timestamp": timestamp,
				...opts.defaultHeaders,
			},
			body: payload,
			signal: controller.signal,
		});

		clearTimeout(timeout);

		const responseBody = await response.text().catch(() => null);

		if (response.ok) {
			await ctx.adapter.rawMutate(
				`UPDATE ${t("webhook_delivery")}
				 SET status = 'delivered', status_code = $1, response_body = $2,
				     attempt = $3, delivered_at = ${d.now()}
				 WHERE id = $4`,
				[response.status, responseBody?.slice(0, 1000) ?? null, attempt, row.id],
			);
			return true;
		}

		await handleDeliveryFailure(
			ctx,
			row.id,
			attempt,
			opts.maxRetries,
			response.status,
			responseBody?.slice(0, 1000) ?? null,
		);
		return false;
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		await handleDeliveryFailure(ctx, row.id, attempt, opts.maxRetries, null, errorMsg);
		return false;
	}
}

async function handleDeliveryFailure(
	ctx: SummaContext,
	deliveryId: string,
	attempt: number,
	maxRetries: number,
	statusCode: number | null,
	responseBody: string | null,
): Promise<void> {
	const t = createTableResolver(ctx.options.schema);
	const d = ctx.dialect;

	if (attempt >= maxRetries) {
		await ctx.adapter.rawMutate(
			`UPDATE ${t("webhook_delivery")}
			 SET status = 'failed', status_code = $1, response_body = $2, attempt = $3
			 WHERE id = $4`,
			[statusCode, responseBody, attempt, deliveryId],
		);
	} else {
		const backoffSec = getBackoffSeconds(attempt);
		await ctx.adapter.rawMutate(
			`UPDATE ${t("webhook_delivery")}
			 SET attempt = $1, status_code = $2, response_body = $3,
			     next_retry_at = ${d.now()} + ${d.interval(`${backoffSec} second`)}
			 WHERE id = $4`,
			[attempt, statusCode, responseBody, deliveryId],
		);
	}
}

async function queueEventForDelivery(
	ctx: SummaContext,
	eventType: string,
	payload: Record<string, unknown>,
): Promise<number> {
	const t = createTableResolver(ctx.options.schema);
	const d = ctx.dialect;
	const ledgerId = getLedgerId(ctx);

	const webhooks = await ctx.adapter.raw<RawWebhookRow>(
		`SELECT * FROM ${t("webhook_endpoint")}
		 WHERE ledger_id = $1 AND active = true`,
		[ledgerId],
	);

	let queued = 0;

	for (const webhook of webhooks) {
		const events = typeof webhook.events === "string" ? JSON.parse(webhook.events) : webhook.events;

		const matches = (events as string[]).some((pattern) => eventMatches(eventType, pattern));
		if (!matches) continue;

		await ctx.adapter.rawMutate(
			`INSERT INTO ${t("webhook_delivery")} (
				id, webhook_id, event_type, payload, status, attempt, created_at
			) VALUES (
				${d.generateUuid()}, $1, $2, $3, 'pending', 0, ${d.now()}
			)`,
			[webhook.id, eventType, JSON.stringify(payload)],
		);
		queued++;
	}

	return queued;
}

// =============================================================================
// STATS
// =============================================================================

export async function getOutboxStats(ctx: SummaContext): Promise<OutboxStats> {
	const t = createTableResolver(ctx.options.schema);
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
       ${ctx.dialect.countAsInt()} AS count
     FROM ${t("outbox")}
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

// =============================================================================
// STREAM PUBLISHER — Bridge outbox to any MessageBus (e.g. Redis Streams)
// =============================================================================

/**
 * Create a publisher callback for the outbox plugin that publishes to a MessageBus.
 *
 * @example
 * ```ts
 * import { createRedisStreamsBus } from "@summa-ledger/message-queue";
 * import { outbox, createStreamPublisher } from "@summa-ledger/summa/plugins";
 *
 * const bus = createRedisStreamsBus({ client: redis });
 * const summa = createSumma({
 *   plugins: [
 *     outbox({ publisher: createStreamPublisher(bus) }),
 *     // or simply: outbox({ messageQueue: bus }),
 *   ],
 * });
 * ```
 */
export function createStreamPublisher(
	bus: MessageBusLike,
	options?: StreamPublisherOptions,
): (topic: string, payload: Record<string, unknown>) => Promise<void> {
	const maxLen = options?.maxLen ?? 100_000;

	return async (topic: string, payload: Record<string, unknown>): Promise<void> => {
		await bus.publish(topic, payload, { maxLen });
	};
}

// =============================================================================
// PLUGIN FACTORY
// =============================================================================

export function outbox(options: OutboxOptions): SummaPlugin {
	if (!options.publisher && !options.messageQueue && !options.webhooks) {
		throw new Error("outbox plugin requires at least one of: publisher, messageQueue, webhooks");
	}

	validatePluginOptions("outbox", options, {
		batchSize: { type: "number", default: 100 },
		maxRetries: { type: "number", default: 3 },
		retentionHours: { type: "number", default: 48 },
	});

	const batchSize = options.batchSize ?? 100;
	const maxRetries = options.maxRetries ?? 3;
	const retentionHours = options.retentionHours ?? 48;
	const webhookOpts = options.webhooks;

	// Resolve publisher: explicit publisher takes priority, then messageQueue bridge
	const publisherFn =
		options.publisher ??
		(options.messageQueue
			? createStreamPublisher(options.messageQueue, options.streamPublisherOptions)
			: undefined);

	// Build workers list
	const workers: SummaPlugin["workers"] = [];

	// Publisher workers (only if publisher is provided)
	// Multiple workers can safely poll concurrently via FOR UPDATE SKIP LOCKED.
	if (publisherFn) {
		const concurrency = options.concurrency ?? 1;
		const perWorkerBatchSize = Math.ceil(batchSize / concurrency);

		for (let i = 0; i < concurrency; i++) {
			workers.push({
				id: concurrency === 1 ? "outbox-processor" : `outbox-processor-${i}`,
				description: `Polls outbox for pending events, publishes via user publisher, handles retries and DLQ${concurrency > 1 ? ` (worker ${i}/${concurrency})` : ""}`,
				interval: "5s",
				leaseRequired: false,
				handler: async (ctx: SummaContext) => {
					const count = await processOutboxBatch(ctx, {
						publisher: publisherFn,
						batchSize: perWorkerBatchSize,
						maxRetries,
					});
					if (count > 0) {
						ctx.logger.info("Outbox batch processed", { count, worker: i });
					}
				},
			});
		}
	}

	// Outbox cleanup worker (always) — cleans both outbox and processed_event tables
	workers.push({
		id: "outbox-cleanup",
		description:
			"Deletes processed outbox entries and processed_event dedup records older than retention period",
		interval: "6h",
		leaseRequired: true,
		handler: async (ctx: SummaContext) => {
			const deleted = await cleanupProcessedOutbox(ctx, retentionHours);
			if (deleted > 0) {
				ctx.logger.info("Outbox cleanup completed", { deleted, retentionHours });
			}
			// Also clean processed_event deduplication records (owned by outbox processing)
			const t = createTableResolver(ctx.options.schema);
			const d = ctx.dialect;
			try {
				const dedupDeleted = await ctx.adapter.rawMutate(
					`DELETE FROM ${t("processed_event")}
					 WHERE processed_at < ${d.now()} - ${d.interval("1 hour")} * $1`,
					[retentionHours],
				);
				if (dedupDeleted > 0) {
					ctx.logger.info("Processed event dedup cleanup completed", {
						deleted: dedupDeleted,
						retentionHours,
					});
				}
			} catch {
				// processed_event table may not exist — skip silently
			}
		},
	});

	// Webhook delivery workers (only if webhooks enabled)
	if (webhookOpts) {
		const whMaxRetries = webhookOpts.maxRetries ?? 5;
		const whTimeoutMs = webhookOpts.timeoutMs ?? 10000;
		const whRetentionDays = webhookOpts.retentionDays ?? 30;

		const whConcurrency = webhookOpts.concurrency ?? 10;

		workers.push({
			id: "webhook-delivery-processor",
			description: "Deliver pending webhooks via HTTP POST with HMAC signatures",
			interval: "5s",
			leaseRequired: false,
			handler: async (ctx: SummaContext) => {
				const count = await processWebhookDeliveries(ctx, {
					maxRetries: whMaxRetries,
					timeoutMs: whTimeoutMs,
					defaultHeaders: webhookOpts.defaultHeaders,
					concurrency: whConcurrency,
				});
				if (count > 0) {
					ctx.logger.info("Webhooks delivered", { count });
				}
			},
		});

		workers.push({
			id: "webhook-delivery-cleanup",
			description: "Remove old delivery logs beyond retention period",
			interval: "1d",
			leaseRequired: true,
			handler: async (ctx: SummaContext) => {
				const t = createTableResolver(ctx.options.schema);
				const d = ctx.dialect;
				const deleted = await ctx.adapter.rawMutate(
					`DELETE FROM ${t("webhook_delivery")}
					 WHERE created_at < ${d.now()} - ${d.interval("1 day")} * $1`,
					[whRetentionDays],
				);
				if (deleted > 0) {
					ctx.logger.info("Cleaned up old webhook deliveries", { count: deleted });
				}
			},
		});
	}

	// Build plugin
	const plugin: SummaPlugin = {
		id: "outbox",

		$Infer: {} as {
			OutboxStats: OutboxStats;
			WebhookEndpoint: WebhookEndpoint;
			WebhookDelivery: WebhookDelivery;
		},

		workers,
	};

	// Add webhook schema + endpoints + hooks only when webhooks enabled
	if (webhookOpts) {
		plugin.schema = webhookSchema;

		plugin.operationHooks = {
			after: [
				{
					matcher: () => true,
					handler: async ({ operation, context }) => {
						await queueEventForDelivery(context, operation.type, operation.params);
					},
				},
			],
		};

		plugin.endpoints = [
			{
				method: "POST",
				path: "/webhooks",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const body = req.body as Record<string, unknown> | null;
					if (!body || typeof body !== "object")
						return json(400, {
							error: { code: "INVALID_ARGUMENT", message: "Request body required" },
						});

					const url = body.url as string | undefined;
					const events = body.events as string[] | undefined;
					if (!url)
						return json(400, { error: { code: "INVALID_ARGUMENT", message: "url is required" } });
					if (!events?.length)
						return json(400, {
							error: { code: "INVALID_ARGUMENT", message: "events array is required" },
						});

					const result = await registerWebhook(ctx, {
						url,
						events,
						description: body.description as string | undefined,
					});
					return json(201, result);
				},
			},
			{
				method: "GET",
				path: "/webhooks",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const result = await listWebhooks(ctx, {
						activeOnly: req.query.activeOnly !== "false",
					});
					return json(200, { webhooks: result });
				},
			},
			{
				method: "PUT",
				path: "/webhooks/:id",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const webhookId = req.params.id ?? "";
					const body = req.body as Record<string, unknown> | null;
					if (!body || typeof body !== "object")
						return json(400, {
							error: { code: "INVALID_ARGUMENT", message: "Request body required" },
						});

					const result = await updateWebhook(ctx, webhookId, {
						url: body.url as string | undefined,
						events: body.events as string[] | undefined,
						active: body.active as boolean | undefined,
						description: body.description as string | undefined,
					});
					return json(200, result);
				},
			},
			{
				method: "DELETE",
				path: "/webhooks/:id",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const webhookId = req.params.id ?? "";
					await deleteWebhook(ctx, webhookId);
					return json(200, { deleted: true });
				},
			},
			{
				method: "GET",
				path: "/webhooks/:id/deliveries",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const webhookId = req.params.id ?? "";
					const result = await getDeliveryLog(ctx, webhookId, {
						page: req.query.page ? Number(req.query.page) : undefined,
						perPage: req.query.perPage ? Number(req.query.perPage) : undefined,
						status: req.query.status,
					});
					return json(200, result);
				},
			},
		];
	}

	return plugin;
}
