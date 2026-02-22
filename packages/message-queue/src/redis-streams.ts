// =============================================================================
// REDIS STREAMS MESSAGE BUS
// =============================================================================
// MessageBus implementation backed by Redis Streams.
// Uses XADD for publishing, XREADGROUP + XACK for consumer groups,
// and XAUTOCLAIM for reclaiming idle pending messages.

import type {
	ConsumeOptions,
	Message,
	MessageBus,
	MessageHandler,
	PublishOptions,
	RedisStreamsClient,
	SubscriptionHandle,
} from "./types.js";

// =============================================================================
// OPTIONS
// =============================================================================

export interface RedisStreamsBusOptions {
	/** An ioredis client instance with stream command support. */
	client: RedisStreamsClient;
	/** Key prefix for all stream keys. Default: "summa:stream:" */
	keyPrefix?: string;
}

// =============================================================================
// IMPLEMENTATION
// =============================================================================

export function createRedisStreamsBus(options: RedisStreamsBusOptions): MessageBus {
	const { client, keyPrefix = "summa:stream:" } = options;

	function streamKey(topic: string): string {
		return `${keyPrefix}${topic}`;
	}

	return {
		async publish(
			topic: string,
			payload: Record<string, unknown>,
			opts?: PublishOptions,
		): Promise<string> {
			const key = streamKey(topic);
			const maxLen = opts?.maxLen ?? 100_000;
			const data = JSON.stringify(payload);
			const publishedAt = new Date().toISOString();

			const id = await client.xadd(
				key,
				"MAXLEN",
				"~",
				maxLen,
				"*",
				"payload",
				data,
				"publishedAt",
				publishedAt,
			);

			if (!id) {
				throw new Error(`XADD returned null for topic ${topic}`);
			}

			return id;
		},

		async subscribe(
			topic: string,
			opts: ConsumeOptions,
			handler: MessageHandler,
		): Promise<SubscriptionHandle> {
			const key = streamKey(topic);
			const {
				group,
				consumer,
				batchSize = 100,
				blockMs = 2000,
				pendingClaimAfterMs = 30_000,
			} = opts;

			// Ensure group exists before consuming
			await ensureGroupInternal(client, key, group);

			let running = true;
			let resolveStop: (() => void) | null = null;
			const stoppedPromise = new Promise<void>((resolve) => {
				resolveStop = resolve;
			});

			// Consumer loop
			const loop = async () => {
				while (running) {
					try {
						// 1. Reclaim idle pending messages from other consumers
						await reclaimPending(client, key, group, consumer, pendingClaimAfterMs, handler, topic);

						// 2. Read new messages
						const result = await client.xreadgroup(
							"GROUP",
							group,
							consumer,
							"COUNT",
							batchSize,
							"BLOCK",
							blockMs,
							"STREAMS",
							key,
							">",
						);

						if (!result || result.length === 0) continue;

						for (const [, entries] of result) {
							for (const [entryId, fields] of entries) {
								const message = parseStreamEntry(entryId, topic, fields);
								if (!message) continue;

								try {
									await handler(message);
									await client.xack(key, group, entryId);
								} catch {
									// Message stays in PEL — will be reclaimed on next iteration
								}
							}
						}
					} catch (_err) {
						// Connection errors etc. — back off briefly
						if (running) {
							await sleep(1000);
						}
					}
				}
				resolveStop?.();
			};

			// Fire and forget — the loop runs in the background
			loop();

			return {
				stop: async () => {
					running = false;
					await stoppedPromise;
				},
			};
		},

		async ensureGroup(topic: string, group: string): Promise<void> {
			await ensureGroupInternal(client, streamKey(topic), group);
		},

		async ping(): Promise<boolean> {
			try {
				const result = await client.ping();
				return result === "PONG";
			} catch {
				return false;
			}
		},
	};
}

// =============================================================================
// INTERNAL HELPERS
// =============================================================================

async function ensureGroupInternal(
	client: RedisStreamsClient,
	key: string,
	group: string,
): Promise<void> {
	try {
		await client.xgroup("CREATE", key, group, "$", "MKSTREAM");
	} catch (err) {
		// BUSYGROUP means the group already exists — idempotent
		if (err instanceof Error && err.message.includes("BUSYGROUP")) {
			return;
		}
		throw err;
	}
}

async function reclaimPending(
	client: RedisStreamsClient,
	key: string,
	group: string,
	consumer: string,
	minIdleTime: number,
	handler: MessageHandler,
	topic: string,
): Promise<void> {
	try {
		const result = await client.xautoclaim(key, group, consumer, minIdleTime, "0-0", "COUNT", 10);

		if (!result || !result[1] || result[1].length === 0) return;

		for (const [entryId, fields] of result[1]) {
			const message = parseStreamEntry(entryId, topic, fields);
			if (!message) continue;

			try {
				await handler(message);
				await client.xack(key, group, entryId);
			} catch {
				// Still pending — will retry next cycle
			}
		}
	} catch {
		// XAUTOCLAIM may fail on older Redis versions — graceful degradation
	}
}

function parseStreamEntry(entryId: string, topic: string, fields: string[]): Message | null {
	// fields is a flat array: ["key1", "val1", "key2", "val2", ...]
	const map = new Map<string, string>();
	for (let i = 0; i < fields.length; i += 2) {
		const k = fields[i];
		const v = fields[i + 1];
		if (k !== undefined && v !== undefined) {
			map.set(k, v);
		}
	}

	const payloadStr = map.get("payload");
	if (!payloadStr) return null;

	try {
		const payload = JSON.parse(payloadStr) as Record<string, unknown>;
		return {
			id: entryId,
			topic,
			payload,
			publishedAt: map.get("publishedAt") ?? new Date().toISOString(),
		};
	} catch {
		return null;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
