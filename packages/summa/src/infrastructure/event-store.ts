// =============================================================================
// EVENT STORE -- Core event sourcing engine
// =============================================================================
// Append-only event log with hash chain integrity.
// All state mutations produce immutable events.

import { randomUUID } from "node:crypto";
import type {
	AppendEventParams,
	StoredEvent,
	SummaContext,
	SummaTransactionAdapter,
} from "@summa/core";
import { computeHash } from "@summa/core";
import { runWithTransactionContext } from "@summa/core/db";

// =============================================================================
// TRANSACTION TIMEOUT WRAPPER
// =============================================================================
// Prevents long-running transactions from blocking operations.

export async function withTransactionTimeout<T>(
	ctx: SummaContext,
	operation: (tx: SummaTransactionAdapter) => Promise<T>,
	options?: { statementTimeoutMs?: number; lockTimeoutMs?: number },
): Promise<T> {
	const statementTimeout = options?.statementTimeoutMs ?? ctx.options.advanced.transactionTimeoutMs;
	const lockTimeout = options?.lockTimeoutMs ?? ctx.options.advanced.lockTimeoutMs;

	const { dialect } = ctx;

	return await runWithTransactionContext(() =>
		ctx.adapter.transaction(async (tx) => {
			// Set isolation level for financial consistency
			await tx.raw("SET TRANSACTION ISOLATION LEVEL READ COMMITTED", []);

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
	);
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
 * @returns The stored event with computed fields
 */
const MAX_VERSION_RETRIES = 3;

export async function appendEvent(
	tx: SummaTransactionAdapter,
	params: AppendEventParams,
): Promise<StoredEvent> {
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
       FROM ledger_event
       WHERE aggregate_type = $1
         AND aggregate_id = $2
       ORDER BY aggregate_version DESC
       LIMIT 1`,
			[params.aggregateType, params.aggregateId],
		);

		const latestEvent = latestRows[0];
		const aggregateVersion = latestEvent ? Number(latestEvent.aggregate_version) + 1 : 1;
		const prevHash = latestEvent?.hash ?? null;

		// Compute hash -- always enabled, no feature flag.
		// Hash chain is critical for tamper detection and MUST NOT be disabled.
		const hash = computeHash(prevHash, params.eventData);

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
				`INSERT INTO ledger_event (id, aggregate_type, aggregate_id, aggregate_version, event_type, event_data, correlation_id, hash, prev_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
				[
					eventId,
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
 */
export async function getEvents(
	ctx: SummaContext,
	aggregateType: string,
	aggregateId: string,
): Promise<StoredEvent[]> {
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
		`SELECT * FROM ledger_event
     WHERE aggregate_type = $1
       AND aggregate_id = $2
     ORDER BY aggregate_version ASC`,
		[aggregateType, aggregateId],
	);

	return rows.map(rowToStoredEvent);
}

/**
 * Get the latest event for an aggregate.
 */
export async function getLatestEvent(
	ctx: SummaContext,
	aggregateType: string,
	aggregateId: string,
): Promise<StoredEvent | null> {
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
		`SELECT * FROM ledger_event
     WHERE aggregate_type = $1
       AND aggregate_id = $2
     ORDER BY aggregate_version DESC
     LIMIT 1`,
		[aggregateType, aggregateId],
	);

	const row = rows[0];
	return row ? rowToStoredEvent(row) : null;
}

/**
 * Get events by correlation ID (all events from a single command).
 */
export async function getEventsByCorrelation(
	ctx: SummaContext,
	correlationId: string,
): Promise<StoredEvent[]> {
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
		`SELECT * FROM ledger_event
     WHERE correlation_id = $1
     ORDER BY sequence_number ASC`,
		[correlationId],
	);

	return rows.map(rowToStoredEvent);
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
