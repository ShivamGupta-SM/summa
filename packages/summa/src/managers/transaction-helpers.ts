// =============================================================================
// TRANSACTION HELPERS — Shared patterns for transaction operations
// =============================================================================
// Extracted from transaction-manager.ts to reduce duplication across
// credit, debit, transfer, and refund operations.

import { randomUUID } from "node:crypto";
import type { SummaContext, SummaTransactionAdapter } from "@summa/core";
import { AGGREGATE_TYPES, SummaError, TRANSACTION_EVENTS } from "@summa/core";
import { createTableResolver } from "@summa/core/db";
import { appendEvent } from "../infrastructure/event-store.js";
import { insertEntryAndUpdateBalance } from "./entry-balance.js";
import { saveIdempotencyKeyInTx } from "./idempotency.js";
import { logTransactionInTx } from "./limit-manager.js";
import type { RawAccountRow, RawTransactionRow } from "./raw-types.js";

// =============================================================================
// AMOUNT VALIDATION
// =============================================================================

/**
 * Validates that amount is a positive integer within the configured max limit.
 * Throws SummaError.invalidArgument on failure.
 */
export function validateAmount(amount: number, maxAmount: number): void {
	if (!Number.isInteger(amount) || amount <= 0 || amount > maxAmount) {
		throw SummaError.invalidArgument(
			"Amount must be a positive integer (in smallest currency units) and not exceed maximum limit",
		);
	}
}

// =============================================================================
// ACCOUNT STATUS CHECK
// =============================================================================

/**
 * Throws the appropriate error if an account is not active.
 */
export function assertAccountActive(account: Pick<RawAccountRow, "status">, label?: string): void {
	if (account.status === "active") return;
	const prefix = label ? `${label} ` : "";
	if (account.status === "frozen")
		throw SummaError.accountFrozen(`${prefix}Account is frozen`.trim());
	if (account.status === "closed")
		throw SummaError.accountClosed(`${prefix}Account is closed`.trim());
	throw SummaError.conflict(`${prefix}Account is ${account.status}`.trim());
}

// =============================================================================
// SYSTEM ACCOUNT LOOKUP
// =============================================================================

/**
 * Looks up a system account by identifier within a transaction.
 * Throws SummaError.notFound if not found.
 */
export async function resolveSystemAccountInTx(
	tx: SummaTransactionAdapter,
	identifier: string,
	schema: string,
): Promise<string> {
	const t = createTableResolver(schema);
	const rows = await tx.raw<{ id: string }>(
		`SELECT id FROM ${t("system_account")} WHERE identifier = $1 LIMIT 1`,
		[identifier],
	);
	if (!rows[0]) {
		throw SummaError.notFound(`System account not found: ${identifier}`);
	}
	return rows[0].id;
}

// =============================================================================
// HOT ACCOUNT ENTRY
// =============================================================================

/**
 * Inserts a hot_account_entry for a system account alongside its entry_record.
 * Returns a Promise that can be batched in Promise.all.
 */
export function insertHotAccountEntry(
	tx: SummaTransactionAdapter,
	schema: string,
	params: {
		systemAccountId: string;
		amount: number;
		entryType: "CREDIT" | "DEBIT";
		transactionId: string;
	},
): Promise<unknown> {
	const t = createTableResolver(schema);
	const signedAmount = params.entryType === "DEBIT" ? -params.amount : params.amount;
	return tx.raw(
		`INSERT INTO ${t("hot_account_entry")} (account_id, amount, entry_type, transaction_id, status)
     VALUES ($1, $2, $3, $4, $5)`,
		[params.systemAccountId, signedAmount, params.entryType, params.transactionId, "pending"],
	);
}

// =============================================================================
// OUTBOX EVENT
// =============================================================================

/**
 * Inserts an outbox event for async notification.
 */
export function insertOutboxEvent(
	tx: SummaTransactionAdapter,
	schema: string,
	topic: string,
	payload: Record<string, unknown>,
): Promise<unknown> {
	const t = createTableResolver(schema);
	return tx.raw(`INSERT INTO ${t("outbox")} (topic, payload) VALUES ($1, $2)`, [
		topic,
		JSON.stringify(payload),
	]);
}

// =============================================================================
// BATCHED SIDE EFFECTS
// =============================================================================

export interface TransactionSideEffectParams {
	tx: SummaTransactionAdapter;
	ctx: SummaContext;
	txnRecord: RawTransactionRow;
	correlationId: string;
	reference: string;
	category: string;
	/** Event type for the event store. Default: TRANSACTION_EVENTS.POSTED */
	eventType?: string;
	/** Aggregate ID for the event store. Default: txnRecord.id */
	eventAggregateId?: string;
	/** Event data for the event store */
	eventData: Record<string, unknown>;
	/** Outbox events to emit */
	outboxEvents: Array<{ topic: string; payload: Record<string, unknown> }>;
	/** Transaction log entries for velocity tracking */
	logEntries: Array<{
		accountId: string;
		txnType: "credit" | "debit";
		amount: number;
	}>;
	/** Idempotency key to save (optional) */
	idempotencyKey?: string;
	/** Pre-built response to cache in idempotency store */
	responseForIdempotency?: unknown;
}

/**
 * Batches independent side effects (outbox, event store, velocity logs, idempotency)
 * into a single Promise.all call. Uses multi-row INSERTs where possible to reduce
 * round-trips. Event store is skipped when enableEventSourcing is false.
 */
export async function batchTransactionSideEffects(
	params: TransactionSideEffectParams,
): Promise<void> {
	const { tx, ctx, txnRecord, correlationId, reference, category } = params;
	const t = createTableResolver(ctx.options.schema);

	const promises: Promise<unknown>[] = [];

	// Outbox events — multi-row INSERT when multiple events
	if (params.outboxEvents.length === 1) {
		promises.push(
			insertOutboxEvent(
				tx,
				ctx.options.schema,
				params.outboxEvents[0].topic,
				params.outboxEvents[0].payload,
			),
		);
	} else if (params.outboxEvents.length > 1) {
		promises.push(batchInsertOutboxEvents(tx, t, params.outboxEvents));
	}

	// Event store — skip when event sourcing is disabled
	if (ctx.options.advanced.enableEventSourcing !== false) {
		promises.push(
			appendEvent(
				tx,
				{
					aggregateType: AGGREGATE_TYPES.TRANSACTION,
					aggregateId: params.eventAggregateId ?? txnRecord.id,
					eventType: params.eventType ?? TRANSACTION_EVENTS.POSTED,
					eventData: params.eventData,
					correlationId,
				},
				ctx.options.schema,
				ctx.options.advanced.hmacSecret,
			),
		);
	}

	// Velocity tracking logs — multi-row INSERT when multiple entries
	if (params.logEntries.length === 1) {
		promises.push(
			logTransactionInTx(tx, {
				accountId: params.logEntries[0].accountId,
				ledgerTxnId: txnRecord.id,
				txnType: params.logEntries[0].txnType,
				amount: params.logEntries[0].amount,
				category,
				reference,
			}),
		);
	} else if (params.logEntries.length > 1) {
		promises.push(
			batchLogTransactions(tx, t, txnRecord.id, category, reference, params.logEntries),
		);
	}

	// Idempotency key
	if (params.idempotencyKey) {
		promises.push(
			saveIdempotencyKeyInTx(tx, {
				key: params.idempotencyKey,
				reference,
				resultData: params.responseForIdempotency,
				ttlMs: ctx.options.advanced.idempotencyTTL,
			}),
		);
	}

	await Promise.all(promises);
}

// =============================================================================
// MULTI-ROW INSERT HELPERS
// =============================================================================

/**
 * Insert multiple outbox events in a single multi-row INSERT statement.
 */
function batchInsertOutboxEvents(
	tx: SummaTransactionAdapter,
	t: (name: string) => string,
	events: Array<{ topic: string; payload: Record<string, unknown> }>,
): Promise<unknown> {
	const valueClauses: string[] = [];
	const allParams: unknown[] = [];
	for (let i = 0; i < events.length; i++) {
		const base = i * 2;
		valueClauses.push(`($${base + 1}, $${base + 2})`);
		allParams.push(events[i].topic, JSON.stringify(events[i].payload));
	}
	return tx.raw(
		`INSERT INTO ${t("outbox")} (topic, payload) VALUES ${valueClauses.join(", ")}`,
		allParams,
	);
}

/**
 * Insert multiple velocity log entries in a single multi-row INSERT statement.
 */
function batchLogTransactions(
	tx: SummaTransactionAdapter,
	t: (name: string) => string,
	ledgerTxnId: string,
	category: string,
	reference: string,
	entries: Array<{ accountId: string; txnType: "credit" | "debit"; amount: number }>,
): Promise<unknown> {
	const valueClauses: string[] = [];
	const allParams: unknown[] = [];
	for (let i = 0; i < entries.length; i++) {
		const base = i * 6;
		valueClauses.push(
			`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`,
		);
		allParams.push(
			entries[i].accountId,
			ledgerTxnId,
			entries[i].txnType,
			entries[i].amount,
			category,
			reference,
		);
	}
	return tx.raw(
		`INSERT INTO ${t("account_transaction_log")} (account_id, ledger_txn_id, txn_type, amount, category, reference) VALUES ${valueClauses.join(", ")}`,
		allParams,
	);
}
