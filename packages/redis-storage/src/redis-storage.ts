// =============================================================================
// REDIS SECONDARY STORAGE
// =============================================================================
// Production-ready SecondaryStorage implementation backed by Redis (via ioredis).
// Provides atomic operations for rate limiting, idempotency caching, and
// distributed state management.
//
// Supports both standalone Redis and Redis Cluster via ioredis's unified API.

import type { SecondaryStorage } from "@summa/core/db";

// =============================================================================
// TYPES
// =============================================================================

/**
 * Minimal interface matching the ioredis Redis/Cluster API surface we need.
 * This avoids a hard type dependency on ioredis internals.
 */
export interface RedisClient {
	get(key: string): Promise<string | null>;
	set(key: string, value: string, ...args: unknown[]): Promise<string | null>;
	del(...keys: string[]): Promise<number>;
	incrby(key: string, amount: number): Promise<number>;
	expire(key: string, seconds: number): Promise<number>;
	ttl(key: string): Promise<number>;
	ping(): Promise<string>;
	quit(): Promise<string>;
	status: string;
}

export interface RedisStorageOptions {
	/** An ioredis client instance (Redis or Cluster) */
	client: RedisClient;

	/** Key prefix for all Summa keys. Default: "summa:" */
	keyPrefix?: string;
}

export interface RedisStorageResult {
	/** The SecondaryStorage implementation */
	storage: SecondaryStorage;

	/** Gracefully disconnect Redis. Call on app shutdown. */
	disconnect: () => Promise<void>;

	/** Health check — returns true if Redis is reachable */
	ping: () => Promise<boolean>;
}

// =============================================================================
// IMPLEMENTATION
// =============================================================================

/**
 * Create a Redis-backed SecondaryStorage for Summa.
 *
 * @example
 * ```ts
 * import Redis from "ioredis";
 * import { createRedisStorage } from "@summa/redis-storage";
 *
 * const redis = new Redis(process.env.REDIS_URL);
 * const { storage, disconnect } = createRedisStorage({ client: redis });
 *
 * const summa = createSumma({
 *   database: adapter,
 *   secondaryStorage: storage,
 * });
 *
 * // On shutdown:
 * await disconnect();
 * ```
 */
export function createRedisStorage(options: RedisStorageOptions): RedisStorageResult {
	const { client, keyPrefix = "summa:" } = options;

	function prefixed(key: string): string {
		return `${keyPrefix}${key}`;
	}

	const storage: SecondaryStorage = {
		async get(key: string): Promise<string | null> {
			return client.get(prefixed(key));
		},

		async set(key: string, value: string, ttl?: number): Promise<void> {
			const fullKey = prefixed(key);
			if (ttl !== undefined && ttl > 0) {
				await client.set(fullKey, value, "EX", ttl);
			} else {
				await client.set(fullKey, value);
			}
		},

		async delete(key: string): Promise<void> {
			await client.del(prefixed(key));
		},

		async increment(key: string, amount?: number): Promise<number> {
			return client.incrby(prefixed(key), amount ?? 1);
		},

		async incrementWithTTL(key: string, ttl: number, amount?: number): Promise<number> {
			const fullKey = prefixed(key);
			const newCount = await client.incrby(fullKey, amount ?? 1);
			if (newCount === (amount ?? 1)) {
				// First increment — set the TTL
				await client.expire(fullKey, ttl);
			}
			return newCount;
		},
	};

	return {
		storage,

		disconnect: async () => {
			if (client.status !== "end") {
				await client.quit();
			}
		},

		ping: async () => {
			try {
				const result = await client.ping();
				return result === "PONG";
			} catch {
				return false;
			}
		},
	};
}
