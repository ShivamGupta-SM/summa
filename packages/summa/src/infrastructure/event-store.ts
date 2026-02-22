// =============================================================================
// EVENT STORE -- Core event sourcing engine
// =============================================================================
// Append-only event log with hash chain integrity.
// All state mutations produce immutable events.

import { randomUUID, timingSafeEqual } from "node:crypto";
import type {
	AppendEventParams,
	StoredEvent,
	SummaContext,
	SummaTransactionAdapter,
} from "@summa/core";
import { computeHash, SummaError } from "@summa/core";
import { createTableResolver, runWithTransactionContext } from "@summa/core/db";

// =============================================================================
// TRANSACTION TIMEOUT WRAPPER
// =============================================================================
// Prevents long-running transactions from blocking operations.
// Supports configurable retry with exponential backoff on lock contention.

export async function withTransactionTimeout<T>(
	ctx: SummaContext,
	operation: (tx: SummaTransactionAdapter) => Promise<T>,
	options?: { statementTimeoutMs?: number; lockTimeoutMs?: number },
): Promise<T> {
	const { advanced } = ctx.options;
	// In optimistic mode, use optimisticRetryCount (default 3) for version conflict retries.
	// In pessimistic modes, use lockRetryCount (default 0).
	const retryCount =
		advanced.lockMode === "optimistic" ? advanced.optimisticRetryCount : advanced.lockRetryCount;
	const baseDelay = advanced.lockRetryBaseDelayMs;
	const maxDelay = advanced.lockRetryMaxDelayMs;

	for (let attempt = 0; attempt <= retryCount; attempt++) {
		try {
			return await executeTransaction(ctx, operation, options);
		} catch (err) {
			if (attempt < retryCount && isRetryableError(err)) {
				const delay = Math.min(baseDelay * 2 ** attempt, maxDelay);
				const jitter = delay * (0.5 + Math.random());
				ctx.logger.debug("Transaction retry due to lock contention", {
					attempt: attempt + 1,
					maxRetries: retryCount,
					delayMs: Math.round(jitter),
				});
				await new Promise((resolve) => setTimeout(resolve, jitter));
				continue;
			}
			throw err;
		}
	}

	// Unreachable — loop always returns or throws
	throw new Error("Unexpected: retry loop exited without result");
}

async function executeTransaction<T>(
	ctx: SummaContext,
	operation: (tx: SummaTransactionAdapter) => Promise<T>,
	options?: { statementTimeoutMs?: number; lockTimeoutMs?: number },
): Promise<T> {
	const statementTimeout = options?.statementTimeoutMs ?? ctx.options.advanced.transactionTimeoutMs;
	const lockTimeout = options?.lockTimeoutMs ?? ctx.options.advanced.lockTimeoutMs;

	const { dialect } = ctx;

	return await runWithTransactionContext(
		() =>
			ctx.adapter.transaction(async (tx) => {
				// Set isolation level for financial consistency
				// REPEATABLE READ prevents dirty reads and non-repeatable reads,
				// ensuring balance checks are consistent within the transaction.
				await tx.raw("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ", []);

				const safeStatementTimeout = Number(statementTimeout);
				const safeLockTimeout = Number(lockTimeout);
				if (!Number.isFinite(safeStatementTimeout) || !Number.isFinite(safeLockTimeout)) {
					throw new Error("Invalid timeout value");
				}
				const stmtTimeoutSql = dialect.setStatementTimeout(safeStatementTimeout);
				const lockTimeoutSql = dialect.setLockTimeout(safeLockTimeout);
				if (stmtTimeoutSql) await tx.raw(`SET LOCAL ${stmtTimeoutSql.replace(/^SET\s+/i, "")}`, []);
				if (lockTimeoutSql) await tx.raw(`SET LOCAL ${lockTimeoutSql.replace(/^SET\s+/i, "")}`, []);
				return await operation(tx);
			}),
		(error, index) => {
			ctx.logger.error("After-commit callback failed", {
				callbackIndex: index,
				error: error instanceof Error ? error.message : String(error),
			});
		},
	);
}

/**
 * Check if a database error is retryable (lock contention, serialization failure, deadlock).
 * PostgreSQL error codes: 55P03 (lock_not_available), 40001 (serialization_failure), 40P01 (deadlock_detected)
 */
function isRetryableError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	const msg = err.message;
	// Check for PG error codes embedded in error messages
	if (msg.includes("55P03") || msg.includes("lock_not_available")) return true;
	if (
		msg.includes("40001") ||
		msg.includes("serialization_failure") ||
		msg.includes("could not serialize")
	)
		return true;
	if (msg.includes("40P01") || msg.includes("deadlock")) return true;
	// Check for lock timeout messages
	if (msg.includes("lock timeout") || msg.includes("canceling statement due to lock timeout"))
		return true;
	// Unique constraint violation (23505) — retryable in optimistic lock mode
	// when two transactions race to insert the same account_balance_version
	if (msg.includes("23505") || msg.includes("unique_violation") || msg.includes("duplicate key"))
		return true;
	// Check for code property on error (common in pg drivers)
	if ("code" in err) {
		const code = (err as { code: string }).code;
		if (code === "55P03" || code === "40001" || code === "40P01" || code === "23505") return true;
	}
	return false;
}

// =============================================================================
// HASH VERIFICATION
// =============================================================================

/** Verify a single event's hash against its stored data. Throws on mismatch. */
function verifyEventHash(
	eventData: Record<string, unknown>,
	storedHash: string,
	prevHash: string | null,
	hmacSecret: string | null,
): void {
	const expected = computeHash(prevHash, eventData, hmacSecret);
	if (
		expected.length !== storedHash.length ||
		!timingSafeEqual(Buffer.from(expected), Buffer.from(storedHash))
	) {
		throw SummaError.chainIntegrityViolation(
			"Hash mismatch detected: event data may have been tampered with",
		);
	}
}

// =============================================================================
// APPEND EVENT
// =============================================================================

/**
 * Append an event to the event store within a transaction.
 * Computes hash chain automatically.
 *
 * @param tx - Transaction adapter
 * @param params - Event parameters
 * @param schema - PostgreSQL schema name
 * @param hmacSecret - HMAC secret for tamper-proof hashing (null = plain SHA-256)
 * @param ledgerId - Ledger ID for multi-tenant isolation
 * @returns The stored event with computed fields
 */
const MAX_VERSION_RETRIES = 3;

export async function appendEvent(
	tx: SummaTransactionAdapter,
	params: AppendEventParams,
	schema = "public",
	hmacSecret: string | null = null,
	ledgerId?: string,
): Promise<StoredEvent> {
	const t = createTableResolver(schema);
	const correlationId = params.correlationId ?? randomUUID();

	// Retry loop handles the rare case where two concurrent transactions
	// compute the same aggregateVersion. The unique constraint
	// (uq_ledger_event_aggregate_version) blocks one; we retry with
	// the correct version to avoid gaps.
	for (let attempt = 0; attempt < MAX_VERSION_RETRIES; attempt++) {
		// Get the latest event for this aggregate to compute version + hash chain
		const latestRows = await tx.raw<{
			aggregate_version: number;
			hash: string;
		}>(
			`SELECT aggregate_version, hash
       FROM ${t("ledger_event")}
       WHERE ledger_id = $1
         AND aggregate_type = $2
         AND aggregate_id = $3
       ORDER BY aggregate_version DESC
       LIMIT 1`,
			[ledgerId ?? null, params.aggregateType, params.aggregateId],
		);

		const latestEvent = latestRows[0];
		const aggregateVersion = latestEvent ? Number(latestEvent.aggregate_version) + 1 : 1;
		const prevHash = latestEvent?.hash ?? null;

		// Compute hash -- always enabled, no feature flag.
		// Hash chain is critical for tamper detection and MUST NOT be disabled.
		// Uses HMAC-SHA256 when secret is provided for tamper-proof integrity.
		const hash = computeHash(prevHash, params.eventData, hmacSecret);

		const eventId = randomUUID();

		try {
			const insertedRows = await tx.raw<{
				id: string;
				sequence_number: number;
				aggregate_type: string;
				aggregate_id: string;
				aggregate_version: number;
				event_type: string;
				event_data: Record<string, unknown>;
				correlation_id: string;
				hash: string;
				prev_hash: string | null;
				created_at: string | Date;
			}>(
				`INSERT INTO ${t("ledger_event")} (id, ledger_id, aggregate_type, aggregate_id, aggregate_version, event_type, event_data, correlation_id, hash, prev_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING *`,
				[
					eventId,
					ledgerId ?? null,
					params.aggregateType,
					params.aggregateId,
					aggregateVersion,
					params.eventType,
					JSON.stringify(params.eventData),
					correlationId,
					hash,
					prevHash,
				],
			);

			const inserted = insertedRows[0]!;

			return {
				id: inserted.id,
				sequenceNumber: Number(inserted.sequence_number),
				aggregateType: inserted.aggregate_type,
				aggregateId: inserted.aggregate_id,
				aggregateVersion: Number(inserted.aggregate_version),
				eventType: inserted.event_type,
				eventData: (typeof inserted.event_data === "string"
					? JSON.parse(inserted.event_data)
					: inserted.event_data) as Record<string, unknown>,
				correlationId: inserted.correlation_id,
				hash: inserted.hash,
				prevHash: inserted.prev_hash,
				createdAt: new Date(inserted.created_at),
			};
		} catch (error) {
			// Check if this is a unique constraint violation on version
			const msg = error instanceof Error ? error.message : String(error);
			if (msg.includes("uq_ledger_event_aggregate_version") && attempt < MAX_VERSION_RETRIES - 1) {
				// Re-read immediately without sleeping inside the transaction.
				continue;
			}
			throw error;
		}
	}

	throw new Error(
		`Failed to append event after ${MAX_VERSION_RETRIES} retries (version collision)`,
	);
}

// =============================================================================
// QUERY EVENTS
// =============================================================================

/**
 * Get all events for an aggregate, ordered by version.
 * When verifyHashOnRead is enabled, verifies the full hash chain.
 */
export async function getEvents(
	ctx: SummaContext,
	aggregateType: string,
	aggregateId: string,
	ledgerId: string,
): Promise<StoredEvent[]> {
	const t = createTableResolver(ctx.options.schema);
	const rows = await ctx.adapter.raw<{
		id: string;
		sequence_number: number;
		aggregate_type: string;
		aggregate_id: string;
		aggregate_version: number;
		event_type: string;
		event_data: Record<string, unknown>;
		correlation_id: string;
		hash: string;
		prev_hash: string | null;
		created_at: string | Date;
	}>(
		`SELECT * FROM ${t("ledger_event")}
     WHERE ledger_id = $1
       AND aggregate_type = $2
       AND aggregate_id = $3
     ORDER BY aggregate_version ASC`,
		[ledgerId, aggregateType, aggregateId],
	);

	const events = rows.map(rowToStoredEvent);

	if (ctx.options.advanced.verifyHashOnRead && events.length > 0) {
		const hmacSecret = ctx.options.advanced.hmacSecret;
		let prevHash: string | null = null;
		for (const event of events) {
			verifyEventHash(event.eventData, event.hash, prevHash, hmacSecret);
			prevHash = event.hash;
		}
	}

	return events;
}

/**
 * Get the latest event for an aggregate.
 * When verifyHashOnRead is enabled, verifies the event's hash.
 */
export async function getLatestEvent(
	ctx: SummaContext,
	aggregateType: string,
	aggregateId: string,
	ledgerId: string,
): Promise<StoredEvent | null> {
	const t = createTableResolver(ctx.options.schema);
	const rows = await ctx.adapter.raw<{
		id: string;
		sequence_number: number;
		aggregate_type: string;
		aggregate_id: string;
		aggregate_version: number;
		event_type: string;
		event_data: Record<string, unknown>;
		correlation_id: string;
		hash: string;
		prev_hash: string | null;
		created_at: string | Date;
	}>(
		`SELECT * FROM ${t("ledger_event")}
     WHERE ledger_id = $1
       AND aggregate_type = $2
       AND aggregate_id = $3
     ORDER BY aggregate_version DESC
     LIMIT 1`,
		[ledgerId, aggregateType, aggregateId],
	);

	const row = rows[0];
	if (!row) return null;

	const event = rowToStoredEvent(row);

	if (ctx.options.advanced.verifyHashOnRead) {
		verifyEventHash(event.eventData, event.hash, event.prevHash, ctx.options.advanced.hmacSecret);
	}

	return event;
}

/**
 * Get events by correlation ID (all events from a single command).
 * When verifyHashOnRead is enabled, verifies each event's hash individually.
 */
export async function getEventsByCorrelation(
	ctx: SummaContext,
	correlationId: string,
	ledgerId: string,
): Promise<StoredEvent[]> {
	const t = createTableResolver(ctx.options.schema);
	const rows = await ctx.adapter.raw<{
		id: string;
		sequence_number: number;
		aggregate_type: string;
		aggregate_id: string;
		aggregate_version: number;
		event_type: string;
		event_data: Record<string, unknown>;
		correlation_id: string;
		hash: string;
		prev_hash: string | null;
		created_at: string | Date;
	}>(
		`SELECT * FROM ${t("ledger_event")}
     WHERE ledger_id = $1
       AND correlation_id = $2
     ORDER BY sequence_number ASC`,
		[ledgerId, correlationId],
	);

	const events = rows.map(rowToStoredEvent);

	if (ctx.options.advanced.verifyHashOnRead) {
		const hmacSecret = ctx.options.advanced.hmacSecret;
		for (const event of events) {
			// Verify each event individually (not chain — events may span aggregates)
			verifyEventHash(event.eventData, event.hash, event.prevHash, hmacSecret);
		}
	}

	return events;
}

// =============================================================================
// HELPERS
// =============================================================================

function rowToStoredEvent(row: {
	id: string;
	sequence_number: number;
	aggregate_type: string;
	aggregate_id: string;
	aggregate_version: number;
	event_type: string;
	event_data: Record<string, unknown>;
	correlation_id: string;
	hash: string;
	prev_hash: string | null;
	created_at: string | Date;
}): StoredEvent {
	return {
		id: row.id,
		sequenceNumber: Number(row.sequence_number),
		aggregateType: row.aggregate_type,
		aggregateId: row.aggregate_id,
		aggregateVersion: Number(row.aggregate_version),
		eventType: row.event_type,
		eventData: (typeof row.event_data === "string"
			? JSON.parse(row.event_data)
			: row.event_data) as Record<string, unknown>,
		correlationId: row.correlation_id,
		hash: row.hash,
		prevHash: row.prev_hash,
		createdAt: new Date(row.created_at),
	};
}
