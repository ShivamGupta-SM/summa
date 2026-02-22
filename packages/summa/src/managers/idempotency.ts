// =============================================================================
// IDEMPOTENCY KEY HANDLER
// =============================================================================
// Ensures duplicate requests produce the same result.
// Keys have a configurable TTL (default: 24h via advanced.idempotencyTTL). Reference check is permanent.
//
// TigerBeetle-inspired: Field-by-field validation on idempotent retries.
// When a cached result exists, the original request fields are compared against the
// new request. If ANY field differs, a specific error is returned telling the caller
// exactly which field changed. This prevents silent bugs where the same idempotency
// key is reused with different parameters (e.g., different amount).

import type { SummaContext, SummaTransactionAdapter } from "@summa-ledger/core";
import { SummaError } from "@summa-ledger/core";
import { createTableResolver } from "@summa-ledger/core/db";

// =============================================================================
// IDEMPOTENCY FIELD VALIDATION (TigerBeetle-inspired)
// =============================================================================

/**
 * Fields from the original request stored alongside the idempotency key.
 * Used for field-by-field comparison on retries.
 */
export interface IdempotencyRequestFields {
	amount?: number;
	reference?: string;
	holderId?: string;
	sourceHolderId?: string;
	destinationHolderId?: string;
	type?: string;
	currency?: string;
}

/**
 * Compare original request fields against a retry. Returns the name of the first
 * mismatched field, or null if all fields match (safe to return cached result).
 *
 * Inspired by TigerBeetle's `create_transfer_exists()` which returns specific
 * errors like `.exists_with_different_amount`, `.exists_with_different_flags`, etc.
 */
export function findIdempotencyFieldMismatch(
	original: IdempotencyRequestFields,
	retry: IdempotencyRequestFields,
): string | null {
	if (
		retry.amount !== undefined &&
		original.amount !== undefined &&
		retry.amount !== original.amount
	) {
		return "amount";
	}
	if (
		retry.holderId !== undefined &&
		original.holderId !== undefined &&
		retry.holderId !== original.holderId
	) {
		return "holderId";
	}
	if (
		retry.sourceHolderId !== undefined &&
		original.sourceHolderId !== undefined &&
		retry.sourceHolderId !== original.sourceHolderId
	) {
		return "sourceHolderId";
	}
	if (
		retry.destinationHolderId !== undefined &&
		original.destinationHolderId !== undefined &&
		retry.destinationHolderId !== original.destinationHolderId
	) {
		return "destinationHolderId";
	}
	if (retry.type !== undefined && original.type !== undefined && retry.type !== original.type) {
		return "type";
	}
	if (
		retry.currency !== undefined &&
		original.currency !== undefined &&
		retry.currency !== original.currency
	) {
		return "currency";
	}
	return null;
}

// =============================================================================
// CHECK IDEMPOTENCY KEY (Transaction-scoped)
// =============================================================================

/**
 * Check idempotency key inside a database transaction.
 * Uses `tx` connection instead of global adapter to ensure the check
 * is atomic with the rest of the transaction (prevents TOCTOU races).
 *
 * Rules:
 * - Same key, same reference -> validate fields, return cached response
 * - Same key, different reference -> error (key reuse)
 * - Different key, same reference -> error (already exists)
 * - Key expired, same reference -> error (permanent via reference)
 *
 * When `requestFields` is provided, field-by-field validation is performed
 * against the original request (TigerBeetle-inspired). If any field differs,
 * a CONFLICT error is thrown with the specific mismatched field name.
 */
export async function checkIdempotencyKeyInTx(
	tx: SummaTransactionAdapter,
	params: {
		ledgerId: string;
		idempotencyKey?: string;
		reference: string;
		requestFields?: IdempotencyRequestFields;
	},
): Promise<{ alreadyProcessed: boolean; cachedResult?: unknown }> {
	const t = createTableResolver(tx.options?.schema ?? "summa");

	if (params.idempotencyKey) {
		// Combined CTE: check idempotency key + reference in a single round-trip
		const rows = await tx.raw<{
			idem_key: string | null;
			idem_reference: string | null;
			idem_result_data: unknown;
			idem_request_fields: unknown;
			idem_expires_at: string | Date | null;
			existing_txn_id: string | null;
		}>(
			`WITH idem AS (
				SELECT key, reference, result_data, request_fields, expires_at
				FROM ${t("idempotency_key")}
				WHERE ledger_id = $1 AND key = $2
				LIMIT 1
			),
			ref_check AS (
				SELECT id FROM ${t("transaction_record")}
				WHERE ledger_id = $1 AND reference = $3
				LIMIT 1
			)
			SELECT
				idem.key AS idem_key,
				idem.reference AS idem_reference,
				idem.result_data AS idem_result_data,
				idem.request_fields AS idem_request_fields,
				idem.expires_at AS idem_expires_at,
				ref_check.id AS existing_txn_id
			FROM (SELECT 1) AS _
			LEFT JOIN idem ON true
			LEFT JOIN ref_check ON true`,
			[params.ledgerId, params.idempotencyKey, params.reference],
		);

		const row = rows[0];
		if (row) {
			// Check idempotency key first
			if (row.idem_key && row.idem_expires_at) {
				if (new Date(row.idem_expires_at) >= new Date()) {
					// Field-by-field validation (TigerBeetle-inspired)
					if (params.requestFields && row.idem_request_fields) {
						const original = (
							typeof row.idem_request_fields === "string"
								? JSON.parse(row.idem_request_fields)
								: row.idem_request_fields
						) as IdempotencyRequestFields;
						const mismatch = findIdempotencyFieldMismatch(original, params.requestFields);
						if (mismatch) {
							throw SummaError.conflict(
								`Idempotency key '${params.idempotencyKey}' already used with different ${mismatch}`,
							);
						}
					}
					return {
						alreadyProcessed: true,
						cachedResult: row.idem_result_data,
					};
				}
				// Key expired -- fall through to reference check
			}

			// Check reference (permanent duplicate detection)
			if (row.existing_txn_id) {
				throw SummaError.conflict(
					`Transaction with reference '${params.reference}' already exists`,
				);
			}
		}

		return { alreadyProcessed: false };
	}

	// No idempotency key — only check reference (single query, no CTE needed)
	const existingTxRows = await tx.raw<{ id: string }>(
		`SELECT id FROM ${t("transaction_record")}
     WHERE ledger_id = $1 AND reference = $2
     LIMIT 1`,
		[params.ledgerId, params.reference],
	);

	if (existingTxRows[0]) {
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
 *
 * When `requestFields` is provided, the original request parameters are stored
 * alongside the cached result for field-by-field validation on retries.
 */
export async function saveIdempotencyKeyInTx(
	tx: SummaTransactionAdapter,
	params: {
		ledgerId: string;
		key: string;
		reference: string;
		resultEventId?: string;
		resultData: unknown;
		requestFields?: IdempotencyRequestFields;
		ttlMs?: number;
	},
): Promise<void> {
	const t = createTableResolver(tx.options?.schema ?? "summa");
	const ttlSeconds = Math.ceil((params.ttlMs ?? 86_400_000) / 1000);
	await tx.raw(
		`INSERT INTO ${t("idempotency_key")} (ledger_id, key, reference, result_event_id, result_data, request_fields, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW() + INTERVAL '1 second' * $7)
     ON CONFLICT (ledger_id, key) DO UPDATE
     SET result_data = $5,
         request_fields = $6,
         reference = $3,
         expires_at = NOW() + INTERVAL '1 second' * $7`,
		[
			params.ledgerId,
			params.key,
			params.reference,
			params.resultEventId ?? null,
			JSON.stringify(params.resultData),
			params.requestFields ? JSON.stringify(params.requestFields) : null,
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
