// =============================================================================
// EVENT STORE -- Entry-based event sourcing
// =============================================================================
// In v2, entries ARE events. The entry table carries hash chain fields directly.
// This module provides:
//   1. Transaction timeout wrapper (withTransactionTimeout)
//   2. Entry query functions that replace the old event store queries
//   3. Hash verification on read

import { timingSafeEqual } from "node:crypto";
import type {
	StoredEvent,
	SummaContext,
	SummaTransactionAdapter,
} from "@summa-ledger/core";
import { computeHash, SummaError } from "@summa-ledger/core";
import { createTableResolver, runWithTransactionContext } from "@summa-ledger/core/db";

// =============================================================================
// TRANSACTION TIMEOUT WRAPPER
// =============================================================================

export async function withTransactionTimeout<T>(
	ctx: SummaContext,
	operation: (tx: SummaTransactionAdapter) => Promise<T>,
	options?: { statementTimeoutMs?: number; lockTimeoutMs?: number },
): Promise<T> {
	const { advanced } = ctx.options;
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

function isRetryableError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	const msg = err.message;
	if (msg.includes("55P03") || msg.includes("lock_not_available")) return true;
	if (
		msg.includes("40001") ||
		msg.includes("serialization_failure") ||
		msg.includes("could not serialize")
	)
		return true;
	if (msg.includes("40P01") || msg.includes("deadlock")) return true;
	if (msg.includes("lock timeout") || msg.includes("canceling statement due to lock timeout"))
		return true;
	if (msg.includes("23505") || msg.includes("unique_violation") || msg.includes("duplicate key"))
		return true;
	if ("code" in err) {
		const code = (err as { code: string }).code;
		if (code === "55P03" || code === "40001" || code === "40P01" || code === "23505") return true;
	}
	return false;
}

// =============================================================================
// HASH VERIFICATION
// =============================================================================

/** Verify a single entry's hash against its stored data. Throws on mismatch. */
function verifyEntryHash(
	entryData: Record<string, unknown>,
	storedHash: string,
	prevHash: string | null,
	hmacSecret: string | null,
): void {
	const expected = computeHash(prevHash, entryData, hmacSecret);
	if (
		expected.length !== storedHash.length ||
		!timingSafeEqual(Buffer.from(expected), Buffer.from(storedHash))
	) {
		throw SummaError.chainIntegrityViolation(
			"Hash mismatch detected: entry data may have been tampered with",
		);
	}
}

// =============================================================================
// QUERY ENTRIES (replaces old event queries)
// =============================================================================

interface RawEntryEventRow {
	id: string;
	sequence_number: number;
	account_id: string;
	transfer_id: string;
	entry_type: string;
	amount: number;
	currency: string;
	balance_before: number | null;
	balance_after: number | null;
	account_version: number | null;
	hash: string;
	prev_hash: string | null;
	created_at: string | Date;
}

/**
 * Get all entries for an account, ordered by sequence.
 * When verifyEntryHashOnRead is enabled, verifies the full hash chain.
 */
export async function getEntriesForAccount(
	ctx: SummaContext,
	accountId: string,
): Promise<StoredEvent[]> {
	const t = createTableResolver(ctx.options.schema);
	const rows = await ctx.adapter.raw<RawEntryEventRow>(
		`SELECT * FROM ${t("entry")}
     WHERE account_id = $1
     ORDER BY sequence_number ASC`,
		[accountId],
	);

	const events = rows.map(entryRowToStoredEvent);

	if (ctx.options.advanced.verifyEntryHashOnRead && events.length > 0) {
		const hmacSecret = ctx.options.advanced.hmacSecret;
		let prevHash: string | null = null;
		for (const event of events) {
			verifyEntryHash(event.eventData, event.hash, prevHash, hmacSecret);
			prevHash = event.hash;
		}
	}

	return events;
}

/**
 * Get entries by transfer ID (all entries from a single transaction).
 */
export async function getEntriesByTransfer(
	ctx: SummaContext,
	transferId: string,
): Promise<StoredEvent[]> {
	const t = createTableResolver(ctx.options.schema);
	const rows = await ctx.adapter.raw<RawEntryEventRow>(
		`SELECT * FROM ${t("entry")}
     WHERE transfer_id = $1
     ORDER BY sequence_number ASC`,
		[transferId],
	);

	return rows.map(entryRowToStoredEvent);
}

// =============================================================================
// BACKWARD COMPAT — Event query functions mapped to entry table
// =============================================================================

/**
 * Get all events for an aggregate. In v2, aggregate_type maps to account_id queries.
 * For transaction aggregates, we query by transfer_id. For account aggregates, by account_id.
 */
export async function getEvents(
	ctx: SummaContext,
	aggregateType: string,
	aggregateId: string,
	_ledgerId: string,
): Promise<StoredEvent[]> {
	if (aggregateType === "account") {
		return getEntriesForAccount(ctx, aggregateId);
	}
	// For transaction aggregates, query entries by transfer_id
	return getEntriesByTransfer(ctx, aggregateId);
}

/**
 * Get the latest event for an aggregate.
 */
export async function getLatestEvent(
	ctx: SummaContext,
	aggregateType: string,
	aggregateId: string,
	_ledgerId: string,
): Promise<StoredEvent | null> {
	const t = createTableResolver(ctx.options.schema);

	const column = aggregateType === "account" ? "account_id" : "transfer_id";
	const rows = await ctx.adapter.raw<RawEntryEventRow>(
		`SELECT * FROM ${t("entry")}
     WHERE ${column} = $1
     ORDER BY sequence_number DESC
     LIMIT 1`,
		[aggregateId],
	);

	const row = rows[0];
	if (!row) return null;
	return entryRowToStoredEvent(row);
}

/**
 * Get entries by correlation ID (from the transfer's correlation_id field).
 * In v2, entries don't have their own correlation_id — it lives on the transfer.
 */
export async function getEventsByCorrelation(
	ctx: SummaContext,
	correlationId: string,
	_ledgerId: string,
): Promise<StoredEvent[]> {
	const t = createTableResolver(ctx.options.schema);
	const rows = await ctx.adapter.raw<RawEntryEventRow>(
		`SELECT e.* FROM ${t("entry")} e
     JOIN ${t("transfer")} tr ON e.transfer_id = tr.id
     WHERE tr.correlation_id = $1
     ORDER BY e.sequence_number ASC`,
		[correlationId],
	);

	return rows.map(entryRowToStoredEvent);
}

// =============================================================================
// HELPERS
// =============================================================================

function entryRowToStoredEvent(row: RawEntryEventRow): StoredEvent {
	return {
		id: row.id,
		sequenceNumber: Number(row.sequence_number),
		aggregateType: "entry",
		aggregateId: row.account_id,
		aggregateVersion: Number(row.account_version ?? row.sequence_number),
		eventType: `entry:${row.entry_type.toLowerCase()}`,
		eventData: {
			transferId: row.transfer_id,
			accountId: row.account_id,
			entryType: row.entry_type,
			amount: Number(row.amount),
			currency: row.currency,
			balanceBefore: row.balance_before != null ? Number(row.balance_before) : null,
			balanceAfter: row.balance_after != null ? Number(row.balance_after) : null,
		},
		correlationId: row.transfer_id,
		hash: row.hash,
		prevHash: row.prev_hash,
		createdAt: new Date(row.created_at),
	};
}
