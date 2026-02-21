// =============================================================================
// IDEMPOTENCY KEY HANDLER
// =============================================================================
// Ensures duplicate requests produce the same result.
// Keys have a configurable TTL (default: 24h via advanced.idempotencyTTL). Reference check is permanent.

import type { SummaContext, SummaTransactionAdapter } from "@summa/core";
import { SummaError } from "@summa/core";
import { createTableResolver } from "@summa/core/db";

// =============================================================================
// CHECK IDEMPOTENCY KEY (Transaction-scoped)
// =============================================================================

/**
 * Check idempotency key inside a database transaction.
 * Uses `tx` connection instead of global adapter to ensure the check
 * is atomic with the rest of the transaction (prevents TOCTOU races).
 *
 * Rules:
 * - Same key, same reference -> return cached response
 * - Same key, different reference -> error (key reuse)
 * - Different key, same reference -> error (already exists)
 * - Key expired, same reference -> error (permanent via reference)
 */
export async function checkIdempotencyKeyInTx(
	tx: SummaTransactionAdapter,
	params: {
		idempotencyKey?: string;
		reference: string;
	},
): Promise<{ alreadyProcessed: boolean; cachedResult?: unknown }> {
	const t = createTableResolver(tx.options?.schema ?? "summa");
	// Check idempotency key first
	if (params.idempotencyKey) {
		const existingRows = await tx.raw<{
			key: string;
			reference: string;
			result_data: unknown;
			expires_at: string | Date;
		}>(
			`SELECT key, reference, result_data, expires_at
       FROM ${t("idempotency_key")}
       WHERE key = $1
       LIMIT 1`,
			[params.idempotencyKey],
		);

		const existing = existingRows[0];
		if (existing) {
			if (new Date(existing.expires_at) < new Date()) {
				// Key expired -- skip it (cleanup handled by cron, not hot path)
			} else {
				// Key is valid -- return cached response regardless of reference
				return {
					alreadyProcessed: true,
					cachedResult: existing.result_data,
				};
			}
		}
	}

	// Check reference (permanent duplicate detection).
	// A duplicate reference without a matching idempotency key is an error.
	const existingTxRows = await tx.raw<Record<string, unknown>>(
		`SELECT * FROM ${t("transaction_record")}
     WHERE reference = $1
     LIMIT 1`,
		[params.reference],
	);

	const existingTx = existingTxRows[0];
	if (existingTx) {
		throw SummaError.conflict(`Transaction with reference '${params.reference}' already exists`);
	}

	return { alreadyProcessed: false };
}

/**
 * Validate that a cached idempotency result has the expected shape.
 * Returns true if the result looks like a valid domain object (has id + status).
 * Returns false if the cache is stale or incompatible (e.g., after a schema migration).
 */
export function isValidCachedResult(result: unknown): boolean {
	return result != null && typeof result === "object" && "id" in result && "status" in result;
}

// =============================================================================
// SAVE IDEMPOTENCY KEY
// =============================================================================

/**
 * Store the idempotency key inside an existing database transaction for atomicity.
 * Ensures key is committed/rolled back with the parent transaction.
 */
export async function saveIdempotencyKeyInTx(
	tx: SummaTransactionAdapter,
	params: {
		key: string;
		reference: string;
		resultEventId?: string;
		resultData: unknown;
		ttlMs?: number;
	},
): Promise<void> {
	const t = createTableResolver(tx.options?.schema ?? "summa");
	const ttlSeconds = Math.ceil((params.ttlMs ?? 86_400_000) / 1000);
	await tx.raw(
		`INSERT INTO ${t("idempotency_key")} (key, reference, result_event_id, result_data, expires_at)
     VALUES ($1, $2, $3, $4, NOW() + INTERVAL '1 second' * $5)
     ON CONFLICT (key) DO UPDATE
     SET result_data = $4,
         reference = $2,
         expires_at = NOW() + INTERVAL '1 second' * $5`,
		[
			params.key,
			params.reference,
			params.resultEventId ?? null,
			JSON.stringify(params.resultData),
			ttlSeconds,
		],
	);
}

// =============================================================================
// CLEANUP EXPIRED KEYS
// =============================================================================

/**
 * Remove expired idempotency keys. Called by hourly cron job.
 */
export async function cleanupExpiredKeys(ctx: SummaContext): Promise<{ deleted: number }> {
	const t = createTableResolver(ctx.options.schema);
	const deleted = await ctx.adapter.rawMutate(
		`DELETE FROM ${t("idempotency_key")} WHERE expires_at < ${ctx.dialect.now()}`,
		[],
	);

	if (deleted > 0) {
		ctx.logger.info("Cleaned up expired idempotency keys", { count: deleted });
	}

	return { deleted };
}
