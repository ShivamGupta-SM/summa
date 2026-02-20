// =============================================================================
// SECONDARY STORAGE INTERFACE
// =============================================================================
// Abstraction for cache/session stores like Redis, Memcached, etc.
// Used by rate limiter, distributed locks, and plugin state caching.

export interface SecondaryStorage {
	/** Get a value by key. Returns null if not found or expired. */
	get(key: string): Promise<string | null>;

	/** Set a value with an optional TTL in seconds. */
	set(key: string, value: string, ttl?: number): Promise<void>;

	/** Delete a key. */
	delete(key: string): Promise<void>;

	/** Increment a numeric value atomically. Returns the new value. */
	increment(key: string, amount?: number): Promise<number>;
}
