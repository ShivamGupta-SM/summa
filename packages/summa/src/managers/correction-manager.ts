// =============================================================================
// CORRECTION MANAGER -- Reversals & Corrections (APPEND-ONLY)
// =============================================================================
// Provides atomic correct() (reverse + re-post) and typed adjustment() entries.
//
// After the immutability refactor:
// - transaction_record is IMMUTABLE (no status, committed_amount, refunded_amount, posted_at)
// - transaction_status is APPEND-ONLY (each status transition = new row)

import { randomUUID } from "node:crypto";
import type {
	JournalEntryLeg,
	LedgerTransaction,
	SummaContext,
	SummaTransactionAdapter,
} from "@summa/core";
import { AGGREGATE_TYPES, SummaError, TRANSACTION_EVENTS } from "@summa/core";
import { createTableResolver } from "@summa/core/db";
import { runAfterOperationHooks } from "../context/hooks.js";
import { appendEvent, withTransactionTimeout } from "../infrastructure/event-store.js";
import { insertEntryAndUpdateBalance } from "./entry-balance.js";
import {
	checkIdempotencyKeyInTx,
	isValidCachedResult,
	saveIdempotencyKeyInTx,
} from "./idempotency.js";
import type { RawTransactionRow } from "./raw-types.js";
import { processJournalLegs, rawToTransactionResponse, txnWithStatusSql } from "./sql-helpers.js";

// =============================================================================
// CORRECT TRANSACTION
// =============================================================================
// Atomic: reverse original + post correcting entries in one DB transaction.
// Links all three records (original, reversal, correction) via correlationId.

export async function correctTransaction(
	ctx: SummaContext,
	params: {
		transactionId: string;
		correctionEntries: JournalEntryLeg[];
		reason: string;
		reference?: string;
		idempotencyKey?: string;
	},
): Promise<{ reversal: LedgerTransaction; correction: LedgerTransaction }> {
	const { transactionId, correctionEntries, reason } = params;

	if (!correctionEntries || correctionEntries.length < 2) {
		throw SummaError.invalidArgument("Correction requires at least 2 entries (debits and credits)");
	}

	// Validate entries are balanced
	let totalDebits = 0;
	let totalCredits = 0;
	for (const entry of correctionEntries) {
		if (!Number.isInteger(entry.amount) || entry.amount <= 0) {
			throw SummaError.invalidArgument("Each entry amount must be a positive integer");
		}
		if (entry.direction === "debit") totalDebits += entry.amount;
		else if (entry.direction === "credit") totalCredits += entry.amount;
		else throw SummaError.invalidArgument(`Invalid direction: must be debit or credit`);

		if (!entry.holderId && !entry.systemAccount) {
			throw SummaError.invalidArgument("Each entry must specify either holderId or systemAccount");
		}
	}

	if (totalDebits !== totalCredits) {
		throw SummaError.invalidArgument(
			`Correction entries must balance: debits (${totalDebits}) !== credits (${totalCredits})`,
		);
	}

	const result = await withTransactionTimeout(ctx, async (tx) => {
		const t = createTableResolver(ctx.options.schema);
		const correctionReference = params.reference ?? `correction_${transactionId}`;

		// Idempotency check
		const idem = await checkIdempotencyKeyInTx(tx, {
			idempotencyKey: params.idempotencyKey,
			reference: correctionReference,
		});
		if (idem.alreadyProcessed && isValidCachedResult(idem.cachedResult)) {
			return idem.cachedResult as { reversal: LedgerTransaction; correction: LedgerTransaction };
		}

		// Lock original transaction + read latest status
		const originalRows = await tx.raw<RawTransactionRow>(
			`${txnWithStatusSql(t)} WHERE tr.id = $1 FOR UPDATE OF tr`,
			[transactionId],
		);

		const original = originalRows[0];
		if (!original) throw SummaError.notFound("Transaction not found");
		if (original.status !== "posted") {
			throw SummaError.conflict(`Cannot correct transaction in status: ${original.status}`);
		}
		if (original.is_reversal) {
			throw SummaError.conflict("Cannot correct a reversal transaction");
		}

		const originalAmount = Number(original.amount);
		const alreadyRefunded = Number(original.refunded_amount ?? 0);
		if (alreadyRefunded > 0) {
			throw SummaError.conflict("Cannot correct a partially or fully refunded transaction");
		}

		const correlationId = randomUUID();

		// === STEP 1: Full reversal of original ===
		// Mark original as reversed via new transaction_status row (APPEND-ONLY)
		await tx.raw(
			`INSERT INTO ${t("transaction_status")} (transaction_id, status, refunded_amount, reason)
       VALUES ($1, $2, $3, $4)`,
			[transactionId, "reversed", originalAmount, `Correction: ${reason}`],
		);

		// Create reversal transaction record (IMMUTABLE — no status)
		const reversalRows = await tx.raw<RawTransactionRow>(
			`INSERT INTO ${t("transaction_record")} (type, reference, amount, currency, description, source_account_id, destination_account_id, source_system_account_id, destination_system_account_id, parent_id, is_reversal, correlation_id, meta_data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING *`,
			[
				"correction",
				`reversal_${original.reference}`,
				originalAmount,
				original.currency,
				`Reversal for correction: ${reason}`,
				original.destination_account_id,
				original.source_account_id,
				original.destination_system_account_id,
				original.source_system_account_id,
				original.id,
				true,
				correlationId,
				JSON.stringify({ reason, correctionOf: transactionId, type: "correction" }),
			],
		);
		const reversal = reversalRows[0];
		if (!reversal) throw SummaError.internal("Failed to insert reversal record");

		// INSERT initial status for reversal (posted immediately)
		await tx.raw(
			`INSERT INTO ${t("transaction_status")} (transaction_id, status, posted_at)
       VALUES ($1, $2, NOW())`,
			[reversal.id, "posted"],
		);

		// Reverse user account entries
		await reverseAccountEntries(
			tx,
			original,
			reversal,
			originalAmount,
			ctx.options.advanced.useDenormalizedBalance,
		);

		// === STEP 2: Post correcting entries ===
		const correctionRows = await tx.raw<RawTransactionRow>(
			`INSERT INTO ${t("transaction_record")} (type, reference, amount, currency, description, parent_id, is_reversal, correlation_id, meta_data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
			[
				"correction",
				correctionReference,
				totalDebits,
				original.currency,
				`Correction: ${reason}`,
				original.id,
				false,
				correlationId,
				JSON.stringify({
					reason,
					correctionOf: transactionId,
					type: "correction",
					entries: correctionEntries,
				}),
			],
		);
		const correction = correctionRows[0];
		if (!correction) throw SummaError.internal("Failed to insert correction record");

		// INSERT initial status for correction (posted immediately)
		await tx.raw(
			`INSERT INTO ${t("transaction_status")} (transaction_id, status, posted_at)
       VALUES ($1, $2, NOW())`,
			[correction.id, "posted"],
		);

		// Process each correction leg
		await processJournalLegs(
			tx,
			ctx,
			correction,
			correctionEntries,
			original.currency,
			"adjustment",
		);

		// Event store: mark original as corrected
		await appendEvent(
			tx,
			{
				aggregateType: AGGREGATE_TYPES.TRANSACTION,
				aggregateId: original.id,
				eventType: TRANSACTION_EVENTS.CORRECTED,
				eventData: {
					reversalId: reversal.id,
					correctionId: correction.id,
					reason,
				},
				correlationId,
			},
			ctx.options.schema,
			ctx.options.advanced.hmacSecret,
		);

		// Event for reversal transaction
		await appendEvent(
			tx,
			{
				aggregateType: AGGREGATE_TYPES.TRANSACTION,
				aggregateId: reversal.id,
				eventType: TRANSACTION_EVENTS.POSTED,
				eventData: {
					postedAt: new Date().toISOString(),
					entries: [],
				},
				correlationId,
			},
			ctx.options.schema,
			ctx.options.advanced.hmacSecret,
		);

		// Event for correction transaction
		await appendEvent(
			tx,
			{
				aggregateType: AGGREGATE_TYPES.TRANSACTION,
				aggregateId: correction.id,
				eventType: TRANSACTION_EVENTS.POSTED,
				eventData: {
					postedAt: new Date().toISOString(),
					entries: correctionEntries,
				},
				correlationId,
			},
			ctx.options.schema,
			ctx.options.advanced.hmacSecret,
		);

		const reversalResponse = rawToTransactionResponse(
			{ ...reversal, status: "posted", posted_at: new Date() },
			"correction",
			original.currency,
		);
		const correctionResponse = rawToTransactionResponse(
			{ ...correction, status: "posted", posted_at: new Date() },
			"correction",
			original.currency,
		);

		// Save idempotency key
		if (params.idempotencyKey) {
			await saveIdempotencyKeyInTx(tx, {
				key: params.idempotencyKey,
				reference: correctionReference,
				resultData: { reversal: reversalResponse, correction: correctionResponse },
				ttlMs: ctx.options.advanced.idempotencyTTL,
			});
		}

		return { reversal: reversalResponse, correction: correctionResponse };
	});

	await runAfterOperationHooks(ctx, {
		type: "transaction.correct",
		params: { transactionId: params.transactionId, reason: params.reason },
	});
	return result;
}

// =============================================================================
// ADJUSTMENT ENTRY
// =============================================================================
// Creates a balanced journal-style entry with adjustmentType metadata.

export async function adjustmentEntry(
	ctx: SummaContext,
	params: {
		entries: JournalEntryLeg[];
		reference: string;
		adjustmentType: "accrual" | "depreciation" | "correction" | "reclassification";
		description?: string;
		metadata?: Record<string, unknown>;
		idempotencyKey?: string;
	},
): Promise<LedgerTransaction> {
	const { entries, reference, adjustmentType, description = "", metadata = {} } = params;

	const VALID_ADJUSTMENT_TYPES: ReadonlySet<string> = new Set([
		"accrual",
		"depreciation",
		"correction",
		"reclassification",
	]);
	if (!VALID_ADJUSTMENT_TYPES.has(adjustmentType)) {
		throw SummaError.invalidArgument(
			`Invalid adjustmentType: "${adjustmentType}". Must be one of: accrual, depreciation, correction, reclassification`,
		);
	}

	if (!entries || entries.length < 2) {
		throw SummaError.invalidArgument("Adjustment requires at least 2 entries (debits and credits)");
	}

	// Validate entries are balanced
	let totalDebits = 0;
	let totalCredits = 0;
	for (const entry of entries) {
		if (!Number.isInteger(entry.amount) || entry.amount <= 0) {
			throw SummaError.invalidArgument("Each entry amount must be a positive integer");
		}
		if (entry.direction === "debit") totalDebits += entry.amount;
		else if (entry.direction === "credit") totalCredits += entry.amount;
		else throw SummaError.invalidArgument(`Invalid direction: must be debit or credit`);

		if (!entry.holderId && !entry.systemAccount) {
			throw SummaError.invalidArgument("Each entry must specify either holderId or systemAccount");
		}
	}

	if (totalDebits !== totalCredits) {
		throw SummaError.invalidArgument(
			`Adjustment entries must balance: debits (${totalDebits}) !== credits (${totalCredits})`,
		);
	}

	const result = await withTransactionTimeout(ctx, async (tx) => {
		const t = createTableResolver(ctx.options.schema);

		// Idempotency check
		const idem = await checkIdempotencyKeyInTx(tx, {
			idempotencyKey: params.idempotencyKey,
			reference,
		});
		if (idem.alreadyProcessed && isValidCachedResult(idem.cachedResult)) {
			return idem.cachedResult as LedgerTransaction;
		}

		const correlationId = randomUUID();

		// Create adjustment transaction record (IMMUTABLE — no status)
		const txnRows = await tx.raw<RawTransactionRow>(
			`INSERT INTO ${t("transaction_record")} (type, reference, amount, currency, description, correlation_id, meta_data)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
			[
				"adjustment",
				reference,
				totalDebits,
				ctx.options.currency,
				description,
				correlationId,
				JSON.stringify({
					...metadata,
					adjustmentType,
					type: "adjustment",
					entries,
				}),
			],
		);
		const txnRecord = txnRows[0];
		if (!txnRecord) throw SummaError.internal("Failed to insert adjustment record");

		// INSERT initial status (posted immediately, APPEND-ONLY)
		await tx.raw(
			`INSERT INTO ${t("transaction_status")} (transaction_id, status, posted_at)
       VALUES ($1, $2, NOW())`,
			[txnRecord.id, "posted"],
		);

		// Process each leg
		await processJournalLegs(tx, ctx, txnRecord, entries, ctx.options.currency, "adjustment");

		// Event store
		await appendEvent(
			tx,
			{
				aggregateType: AGGREGATE_TYPES.TRANSACTION,
				aggregateId: txnRecord.id,
				eventType: TRANSACTION_EVENTS.POSTED,
				eventData: {
					postedAt: new Date().toISOString(),
					adjustmentType,
					entries,
				},
				correlationId,
			},
			ctx.options.schema,
			ctx.options.advanced.hmacSecret,
		);

		const response = rawToTransactionResponse(
			{ ...txnRecord, status: "posted", posted_at: new Date() },
			"adjustment",
			ctx.options.currency,
		);

		// Save idempotency key
		if (params.idempotencyKey) {
			await saveIdempotencyKeyInTx(tx, {
				key: params.idempotencyKey,
				reference,
				resultData: response,
				ttlMs: ctx.options.advanced.idempotencyTTL,
			});
		}

		return response;
	});

	await runAfterOperationHooks(ctx, {
		type: "transaction.adjust",
		params: { entries, reference, adjustmentType },
	});
	return result;
}

// =============================================================================
// SHARED HELPERS
// =============================================================================

/**
 * Reverse all account entries from an original transaction within the same DB transaction.
 */
async function reverseAccountEntries(
	tx: SummaTransactionAdapter,
	original: RawTransactionRow,
	reversal: RawTransactionRow,
	amount: number,
	updateDenormalizedCache = false,
): Promise<void> {
	const t = createTableResolver(tx.options?.schema ?? "summa");

	// User account entries are sequential (SELECT+INSERT+UPDATE)
	if (original.destination_account_id) {
		await insertEntryAndUpdateBalance({
			tx,
			transactionId: reversal.id,
			accountId: original.destination_account_id,
			entryType: "DEBIT",
			amount,
			currency: original.currency,
			isHotAccount: false,
			updateDenormalizedCache,
		});
	}

	if (original.source_account_id) {
		await insertEntryAndUpdateBalance({
			tx,
			transactionId: reversal.id,
			accountId: original.source_account_id,
			entryType: "CREDIT",
			amount,
			currency: original.currency,
			isHotAccount: false,
			updateDenormalizedCache,
		});
	}

	// Reverse system account entries via hot account pattern (batchable)
	const hotOps: Promise<unknown>[] = [];

	if (original.source_system_account_id) {
		hotOps.push(
			tx.raw(
				`INSERT INTO ${t("hot_account_entry")} (account_id, amount, entry_type, transaction_id, status)
         VALUES ($1, $2, $3, $4, $5)`,
				[original.source_system_account_id, amount, "CREDIT", reversal.id, "pending"],
			),
			insertEntryAndUpdateBalance({
				tx,
				transactionId: reversal.id,
				systemAccountId: original.source_system_account_id,
				entryType: "CREDIT",
				amount,
				currency: original.currency,
				isHotAccount: true,
			}),
		);
	}

	if (original.destination_system_account_id) {
		hotOps.push(
			tx.raw(
				`INSERT INTO ${t("hot_account_entry")} (account_id, amount, entry_type, transaction_id, status)
         VALUES ($1, $2, $3, $4, $5)`,
				[original.destination_system_account_id, -amount, "DEBIT", reversal.id, "pending"],
			),
			insertEntryAndUpdateBalance({
				tx,
				transactionId: reversal.id,
				systemAccountId: original.destination_system_account_id,
				entryType: "DEBIT",
				amount,
				currency: original.currency,
				isHotAccount: true,
			}),
		);
	}

	if (hotOps.length > 0) await Promise.all(hotOps);
}
