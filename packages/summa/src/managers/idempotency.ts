// =============================================================================
// IDEMPOTENCY KEY HANDLER
// =============================================================================
// Ensures duplicate requests produce the same result.
// Keys have a 24-hour TTL. Reference check is permanent.

import type { SummaContext, SummaTransactionAdapter } from "@summa/core";
import { SummaError } from "@summa/core";

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
	// Check idempotency key first
	if (params.idempotencyKey) {
		const existingRows = await tx.raw<{
			key: string;
			reference: string;
			result_data: unknown;
			expires_at: string | Date;
		}>(
			`SELECT key, reference, result_data, expires_at
       FROM idempotency_key
       WHERE key = $1
       LIMIT 1`,
			[params.idempotencyKey],
		);

		const existing = existingRows[0];
		if (existing) {
			if (new Date(existing.expires_at) < new Date()) {
				// Key expired -- skip it (cleanup handled by cron, not hot path)
			} else {
				// Key is valid
				if (existing.reference !== params.reference) {
					throw SummaError.invalidArgument(
						`Idempotency key '${params.idempotencyKey}' was used for a different transaction`,
					);
				}
				// Legitimate retry -- return cached response
				return {
					alreadyProcessed: true,
					cachedResult: existing.result_data,
				};
			}
		}
	}

	// Check reference (permanent duplicate detection).
	// Return as cached result instead of error -- client may be retrying
	// after idempotency key expired but the original request succeeded.
	const existingTxRows = await tx.raw<Record<string, unknown>>(
		`SELECT * FROM transaction_record
     WHERE reference = $1
     LIMIT 1`,
		[params.reference],
	);

	const existingTx = existingTxRows[0];
	if (existingTx) {
		return {
			alreadyProcessed: true,
			cachedResult: existingTx,
		};
	}

	return { alreadyProcessed: false };
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
	},
): Promise<void> {
	await tx.raw(
		`INSERT INTO idempotency_key (key, reference, result_event_id, result_data)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (key) DO UPDATE
     SET result_data = $4,
         reference = $2`,
		[params.key, params.reference, params.resultEventId ?? null, JSON.stringify(params.resultData)],
	);
}

// =============================================================================
// CLEANUP EXPIRED KEYS
// =============================================================================

/**
 * Remove expired idempotency keys. Called by hourly cron job.
 */
export async function cleanupExpiredKeys(ctx: SummaContext): Promise<{ deleted: number }> {
	const deleted = await ctx.adapter.rawMutate(
		`DELETE FROM idempotency_key WHERE expires_at < NOW()`,
		[],
	);

	if (deleted > 0) {
		ctx.logger.info("Cleaned up expired idempotency keys", { count: deleted });
	}

	return { deleted };
}
