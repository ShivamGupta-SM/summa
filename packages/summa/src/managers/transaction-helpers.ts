// =============================================================================
// TRANSACTION HELPERS — Shared patterns for transaction operations
// =============================================================================
// Extracted from transaction-manager.ts to reduce duplication across
// credit, debit, transfer, and refund operations.
//
// v2 changes:
// - System accounts are in unified `account` table (is_system=true)
// - No more hot_account_entry table — system account entries go to `entry`
// - No more appendEvent — entries ARE events
// - No more account_transaction_log — velocity queries use `entry` directly

import type { SummaContext, SummaTransactionAdapter } from "@summa-ledger/core";
import { SummaError } from "@summa-ledger/core";
import { createTableResolver } from "@summa-ledger/core/db";
import { saveIdempotencyKeyInTx } from "./idempotency.js";
import type { RawAccountRow, RawTransferRow } from "./raw-types.js";

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
// SYSTEM ACCOUNT LOOKUP (with in-memory cache)
// =============================================================================

/**
 * In-memory cache for system account IDs. System accounts are immutable after
 * creation, so we can cache them indefinitely. Key: "ledgerId:identifier".
 */
const systemAccountCache = new Map<string, string>();

/** Clear the system account cache (useful for testing). */
export function clearSystemAccountCache(): void {
	systemAccountCache.clear();
}

/**
 * Looks up a system account by identifier within a transaction.
 * In v2, system accounts are in the unified `account` table with is_system=true.
 * Results are cached in-memory since system accounts are immutable.
 * Throws SummaError.notFound if not found.
 */
export async function resolveSystemAccountInTx(
	tx: SummaTransactionAdapter,
	identifier: string,
	schema: string,
	ledgerId: string,
): Promise<string> {
	const cacheKey = `${ledgerId}:${identifier}`;
	const cached = systemAccountCache.get(cacheKey);
	if (cached) return cached;

	const t = createTableResolver(schema);
	const rows = await tx.raw<{ id: string }>(
		`SELECT id FROM ${t("account")} WHERE ledger_id = $1 AND system_identifier = $2 AND is_system = true LIMIT 1`,
		[ledgerId, identifier],
	);
	if (!rows[0]) {
		throw SummaError.notFound(`System account not found: ${identifier}`);
	}
	systemAccountCache.set(cacheKey, rows[0].id);
	return rows[0].id;
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
	ledgerId: string;
	txnRecord: RawTransferRow;
	correlationId: string;
	reference: string;
	category: string;
	/** Outbox events to emit */
	outboxEvents: Array<{ topic: string; payload: Record<string, unknown> }>;
	/** Idempotency key to save (optional) */
	idempotencyKey?: string;
	/** Pre-built response to cache in idempotency store */
	responseForIdempotency?: unknown;
}

/**
 * Batches independent side effects (outbox, idempotency) into a single
 * Promise.all call. Uses multi-row INSERTs where possible.
 *
 * v2 simplification: No more event store append (entries ARE events),
 * no more velocity log insert (queries use entry table directly).
 */
export async function batchTransactionSideEffects(
	params: TransactionSideEffectParams,
): Promise<void> {
	const { tx, ctx } = params;
	const t = createTableResolver(ctx.options.schema);

	const promises: Promise<unknown>[] = [];

	// Outbox events — multi-row INSERT when multiple events
	if (params.outboxEvents.length === 1) {
		const [evt] = params.outboxEvents;
		if (evt) {
			promises.push(insertOutboxEvent(tx, ctx.options.schema, evt.topic, evt.payload));
		}
	} else if (params.outboxEvents.length > 1) {
		promises.push(batchInsertOutboxEvents(tx, t, params.outboxEvents));
	}

	// Idempotency key
	if (params.idempotencyKey) {
		promises.push(
			saveIdempotencyKeyInTx(tx, {
				ledgerId: params.ledgerId,
				key: params.idempotencyKey,
				reference: params.reference,
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
		const evt = events[i] as (typeof events)[number];
		const base = i * 2;
		valueClauses.push(`($${base + 1}, $${base + 2})`);
		allParams.push(evt.topic, JSON.stringify(evt.payload));
	}
	return tx.raw(
		`INSERT INTO ${t("outbox")} (topic, payload) VALUES ${valueClauses.join(", ")}`,
		allParams,
	);
}
