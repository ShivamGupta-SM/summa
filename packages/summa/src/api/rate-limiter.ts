// =============================================================================
// RATE LIMITER
// =============================================================================
// Token bucket / sliding window rate limiter with pluggable storage backends.
// Ported from the original Encore ledger's middleware/rate-limiter.ts.

import type { SecondaryStorage, SummaAdapter } from "@summa/core";
import { createTableResolver } from "@summa/core/db";

// =============================================================================
// TYPES
// =============================================================================

export interface RateLimitConfig {
	/** Window size in seconds */
	window: number;
	/** Max operations allowed in window */
	max: number;
	/** Storage backend. Default: "memory" */
	storage?: "memory" | "database" | "secondary";
}

export interface RateLimitResult {
	allowed: boolean;
	remaining: number;
	resetAt: Date;
	/** Max operations allowed in window */
	limit: number;
}

export interface RateLimiter {
	/** Check if an operation is allowed without consuming a token */
	check(key: string): Promise<RateLimitResult>;
	/** Consume a token (throws if rate limited) */
	consume(key: string): Promise<RateLimitResult>;
	/** Reset the counter for a key */
	reset(key: string): Promise<void>;
}

// =============================================================================
// PRESETS
// =============================================================================

/** 100 requests per 60 seconds (standard endpoints) */
export const standardRateLimit: RateLimitConfig = { window: 60, max: 100 };

/** 20 requests per 60 seconds (sensitive endpoints) */
export const strictRateLimit: RateLimitConfig = { window: 60, max: 20 };

/** 500 requests per 60 seconds (read-heavy endpoints) */
export const lenientRateLimit: RateLimitConfig = { window: 60, max: 500 };

/** 10 requests per 1 second (burst protection) */
export const burstRateLimit: RateLimitConfig = { window: 1, max: 10 };

// =============================================================================
// FACTORY
// =============================================================================

export function createRateLimiter(
	config: RateLimitConfig,
	ctx: { adapter?: SummaAdapter; secondaryStorage?: SecondaryStorage; schema?: string },
): RateLimiter {
	const storage = config.storage ?? "memory";

	switch (storage) {
		case "memory":
			return createMemoryRateLimiter(config);
		case "database":
			if (!ctx.adapter) {
				throw new Error("Database adapter required for database-backed rate limiter");
			}
			return createDatabaseRateLimiter(config, ctx.adapter, ctx.schema);
		case "secondary":
			if (!ctx.secondaryStorage) {
				throw new Error("Secondary storage required for secondary-storage-backed rate limiter");
			}
			return createSecondaryRateLimiter(config, ctx.secondaryStorage);
		default:
			throw new Error(`Unknown rate limiter storage: ${storage}`);
	}
}

// =============================================================================
// MEMORY BACKEND
// =============================================================================

interface MemoryBucket {
	tokens: number;
	resetAt: number;
}

function createMemoryRateLimiter(config: RateLimitConfig): RateLimiter {
	const buckets = new Map<string, MemoryBucket>();
	const MAX_ENTRIES = 10_000;

	function getBucket(key: string): MemoryBucket {
		const now = Date.now();
		let bucket = buckets.get(key);

		if (!bucket || now >= bucket.resetAt) {
			bucket = { tokens: config.max, resetAt: now + config.window * 1000 };
			buckets.set(key, bucket);

			// Evict old entries if map grows too large
			if (buckets.size > MAX_ENTRIES) {
				const keysToDelete: string[] = [];
				for (const [k, v] of buckets) {
					if (now >= v.resetAt) keysToDelete.push(k);
					if (keysToDelete.length >= MAX_ENTRIES / 2) break;
				}
				for (const k of keysToDelete) buckets.delete(k);
			}
		}

		return bucket;
	}

	return {
		async check(key: string): Promise<RateLimitResult> {
			const bucket = getBucket(key);
			return {
				allowed: bucket.tokens > 0,
				remaining: Math.max(0, bucket.tokens),
				resetAt: new Date(bucket.resetAt),
				limit: config.max,
			};
		},

		async consume(key: string): Promise<RateLimitResult> {
			const bucket = getBucket(key);
			if (bucket.tokens <= 0) {
				return {
					allowed: false,
					remaining: 0,
					resetAt: new Date(bucket.resetAt),
					limit: config.max,
				};
			}
			bucket.tokens--;
			return {
				allowed: true,
				remaining: bucket.tokens,
				resetAt: new Date(bucket.resetAt),
				limit: config.max,
			};
		},

		async reset(key: string): Promise<void> {
			buckets.delete(key);
		},
	};
}

// =============================================================================
// DATABASE BACKEND (sliding window via PostgreSQL)
// =============================================================================

function createDatabaseRateLimiter(
	config: RateLimitConfig,
	adapter: SummaAdapter,
	schema?: string,
): RateLimiter {
	const t = createTableResolver(schema ?? "summa");

	async function getCount(key: string): Promise<{ count: number; windowStart: Date }> {
		const windowStart = new Date(Date.now() - config.window * 1000);
		const rows = await adapter.raw<{ cnt: string }>(
			`SELECT COUNT(*) as cnt FROM ${t("rate_limit_log")}
			 WHERE key = $1 AND created_at >= $2`,
			[key, windowStart.toISOString()],
		);
		return { count: Number(rows[0]?.cnt ?? 0), windowStart };
	}

	return {
		async check(key: string): Promise<RateLimitResult> {
			const { count } = await getCount(key);
			const remaining = Math.max(0, config.max - count);
			return {
				allowed: remaining > 0,
				remaining,
				resetAt: new Date(Date.now() + config.window * 1000),
				limit: config.max,
			};
		},

		async consume(key: string): Promise<RateLimitResult> {
			// Use a transaction to atomically check count + insert in one step,
			// preventing two concurrent requests from both passing the limit.
			return adapter.transaction(async (tx) => {
				const windowStart = new Date(Date.now() - config.window * 1000);
				const rows = await tx.raw<{ cnt: string }>(
					`SELECT COUNT(*) as cnt FROM ${t("rate_limit_log")}
					 WHERE key = $1 AND created_at >= $2
					 FOR UPDATE`,
					[key, windowStart.toISOString()],
				);
				const count = Number(rows[0]?.cnt ?? 0);

				if (count >= config.max) {
					return {
						allowed: false,
						remaining: 0,
						resetAt: new Date(Date.now() + config.window * 1000),
						limit: config.max,
					};
				}

				await tx.rawMutate(
					`INSERT INTO ${t("rate_limit_log")} (key, created_at) VALUES ($1, NOW())`,
					[key],
				);
				const remaining = Math.max(0, config.max - count - 1);
				return {
					allowed: true,
					remaining,
					resetAt: new Date(Date.now() + config.window * 1000),
					limit: config.max,
				};
			});
		},

		async reset(key: string): Promise<void> {
			await adapter.rawMutate(`DELETE FROM ${t("rate_limit_log")} WHERE key = $1`, [key]);
		},
	};
}

// =============================================================================
// SECONDARY STORAGE BACKEND (Redis-compatible)
// =============================================================================

function createSecondaryRateLimiter(
	config: RateLimitConfig,
	storage: SecondaryStorage,
): RateLimiter {
	const prefix = "summa:ratelimit:";

	return {
		async check(key: string): Promise<RateLimitResult> {
			const val = await storage.get(`${prefix}${key}`);
			const count = val ? Number.parseInt(val, 10) : 0;
			const remaining = Math.max(0, config.max - count);
			return {
				allowed: remaining > 0,
				remaining,
				resetAt: new Date(Date.now() + config.window * 1000),
				limit: config.max,
			};
		},

		async consume(key: string): Promise<RateLimitResult> {
			const fullKey = `${prefix}${key}`;
			let newCount: number;
			if (storage.incrementWithTTL) {
				newCount = await storage.incrementWithTTL(fullKey, config.window);
			} else {
				newCount = await storage.increment(fullKey);
				// Set TTL on first increment (non-atomic fallback)
				if (newCount === 1) {
					await storage.set(fullKey, String(newCount), config.window);
				}
			}
			const remaining = Math.max(0, config.max - newCount);
			return {
				allowed: newCount <= config.max,
				remaining,
				resetAt: new Date(Date.now() + config.window * 1000),
				limit: config.max,
			};
		},

		async reset(key: string): Promise<void> {
			await storage.delete(`${prefix}${key}`);
		},
	};
}
