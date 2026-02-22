// =============================================================================
// MESSAGE QUEUE TYPES
// =============================================================================
// Generic MessageBus interface for event delivery.
// The only implementation shipped is Redis Streams, but the interface allows
// swapping in other backends (e.g., PostgreSQL LISTEN/NOTIFY for simpler setups).

// =============================================================================
// MESSAGE BUS
// =============================================================================

export interface MessageBus {
	/** Publish a message to a topic. Returns the stream entry ID. */
	publish(
		topic: string,
		payload: Record<string, unknown>,
		options?: PublishOptions,
	): Promise<string>;

	/** Subscribe to a topic with consumer group semantics. Returns a handle to stop consuming. */
	subscribe(
		topic: string,
		options: ConsumeOptions,
		handler: MessageHandler,
	): Promise<SubscriptionHandle>;

	/** Ensure a consumer group exists for a topic. Idempotent. */
	ensureGroup(topic: string, group: string): Promise<void>;

	/** Health check — returns true if the transport is reachable. */
	ping(): Promise<boolean>;
}

// =============================================================================
// OPTIONS & HANDLERS
// =============================================================================

export interface PublishOptions {
	/** Approximate max stream length (MAXLEN ~). Default: 100_000 */
	maxLen?: number;
}

export interface ConsumeOptions {
	/** Consumer group name. */
	group: string;
	/** Consumer name within the group (should be unique per process). */
	consumer: string;
	/** Max messages per XREADGROUP call. Default: 100 */
	batchSize?: number;
	/** Block timeout in ms for XREADGROUP. Default: 2000 */
	blockMs?: number;
	/** Reclaim pending messages idle longer than this (ms). Default: 30_000 */
	pendingClaimAfterMs?: number;
}

export interface Message {
	/** Stream entry ID (e.g., "1234567890-0"). */
	id: string;
	/** The topic/stream this message came from. */
	topic: string;
	/** Deserialized message payload. */
	payload: Record<string, unknown>;
	/** ISO timestamp when the message was published. */
	publishedAt: string;
}

export type MessageHandler = (message: Message) => Promise<void>;

export interface SubscriptionHandle {
	/** Stop consuming. Resolves when the consumer loop exits cleanly. */
	stop: () => Promise<void>;
}

// =============================================================================
// REDIS STREAMS CLIENT INTERFACE
// =============================================================================
// Minimal interface matching ioredis commands needed for Redis Streams.
// Avoids hard type dependency on ioredis internals.

export interface RedisStreamsClient {
	/** XADD command */
	xadd(key: string, ...args: (string | number)[]): Promise<string | null>;
	/** XREADGROUP command */
	xreadgroup(
		...args: (string | number)[]
	): Promise<Array<[string, Array<[string, string[]]>]> | null>;
	/** XACK command */
	xack(key: string, group: string, ...ids: string[]): Promise<number>;
	/** XGROUP command */
	xgroup(...args: (string | number)[]): Promise<unknown>;
	/** XAUTOCLAIM command */
	xautoclaim(
		key: string,
		group: string,
		consumer: string,
		minIdleTime: number,
		start: string,
		...args: (string | number)[]
	): Promise<[string, Array<[string, string[]]>]>;
	/** XLEN command */
	xlen(key: string): Promise<number>;
	/** PING for health check */
	ping(): Promise<string>;
	/** Connection status */
	status: string;
}
