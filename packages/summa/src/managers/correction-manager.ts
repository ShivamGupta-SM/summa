// =============================================================================
// CORRECTION MANAGER -- Reversals & Corrections
// =============================================================================
// Provides atomic correct() (reverse + re-post) and typed adjustment() entries.
//
// v2 changes:
// - transfer table has status as a mutable column
// - no separate transaction_status table
// - entries ARE events (no appendEvent)
// - unified account model (no system account FK columns)
// - status transitions logged to entity_status_log

import { randomUUID } from "node:crypto";
import type {
	JournalEntryLeg,
	LedgerTransaction,
	SummaContext,
	SummaTransactionAdapter,
} from "@summa-ledger/core";
import { SummaError } from "@summa-ledger/core";
import { createTableResolver } from "@summa-ledger/core/db";
import { runAfterOperationHooks } from "../context/hooks.js";
import { withTransactionTimeout } from "../infrastructure/event-store.js";
import { insertEntryAndUpdateBalance } from "./entry-balance.js";
import {
	checkIdempotencyKeyInTx,
	isValidCachedResult,
	saveIdempotencyKeyInTx,
} from "./idempotency.js";
import { getLedgerId } from "./ledger-helpers.js";
import type { RawTransferRow } from "./raw-types.js";
import { processJournalLegs, rawToTransactionResponse } from "./sql-helpers.js";

// =============================================================================
// CORRECT TRANSACTION
// =============================================================================

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

	const ledgerId = getLedgerId(ctx);

	const result = await withTransactionTimeout(ctx, async (tx) => {
		const t = createTableResolver(ctx.options.schema);
		const correctionReference = params.reference ?? `correction_${transactionId}`;

		// Idempotency check
		const idem = await checkIdempotencyKeyInTx(tx, {
			ledgerId,
			idempotencyKey: params.idempotencyKey,
			reference: correctionReference,
		});
		if (idem.alreadyProcessed && isValidCachedResult(idem.cachedResult)) {
			return idem.cachedResult as { reversal: LedgerTransaction; correction: LedgerTransaction };
		}

		// Lock original transfer + read status (status is directly on transfer row)
		const originalRows = await tx.raw<RawTransferRow>(
			`SELECT * FROM ${t("transfer")} WHERE id = $1 AND ledger_id = $2 FOR UPDATE`,
			[transactionId, ledgerId],
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
		// Mark original as reversed (mutable status in v2)
		await tx.raw(
			`UPDATE ${t("transfer")} SET status = 'reversed', refunded_amount = $1 WHERE id = $2`,
			[originalAmount, transactionId],
		);

		// Log status transition
		await tx.raw(
			`INSERT INTO ${t("entity_status_log")} (entity_type, entity_id, status, previous_status, reason)
       VALUES ('transfer', $1, 'reversed', 'posted', $2)`,
			[transactionId, `Correction: ${reason}`],
		);

		// Create reversal transfer record
		const reversalRows = await tx.raw<RawTransferRow>(
			`INSERT INTO ${t("transfer")} (ledger_id, type, status, reference, amount, currency, description, source_account_id, destination_account_id, parent_id, is_reversal, correlation_id, metadata, posted_at)
       VALUES ($1, $2, 'posted', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
       RETURNING *`,
			[
				ledgerId,
				"correction",
				`reversal_${original.reference}`,
				originalAmount,
				original.currency,
				`Reversal for correction: ${reason}`,
				original.destination_account_id,
				original.source_account_id,
				original.id,
				true,
				correlationId,
				JSON.stringify({ reason, correctionOf: transactionId, type: "correction" }),
			],
		);
		const reversal = reversalRows[0];
		if (!reversal) throw SummaError.internal("Failed to insert reversal record");

		// Reverse user account entries
		await reverseAccountEntries(tx, original, reversal, originalAmount);

		// === STEP 2: Post correcting entries ===
		const correctionRows = await tx.raw<RawTransferRow>(
			`INSERT INTO ${t("transfer")} (ledger_id, type, status, reference, amount, currency, description, parent_id, is_reversal, correlation_id, metadata, posted_at)
       VALUES ($1, $2, 'posted', $3, $4, $5, $6, $7, $8, $9, $10, NOW())
       RETURNING *`,
			[
				ledgerId,
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

		// Process each correction leg
		await processJournalLegs(
			tx,
			ctx,
			correction,
			correctionEntries,
			original.currency,
			"adjustment",
			ledgerId,
		);

		const reversalResponse = rawToTransactionResponse(reversal, "correction", original.currency);
		const correctionResponse = rawToTransactionResponse(
			correction,
			"correction",
			original.currency,
		);

		// Save idempotency key
		if (params.idempotencyKey) {
			await saveIdempotencyKeyInTx(tx, {
				ledgerId,
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

export async function adjustmentEntry(
	ctx: SummaContext,
	params: {
		entries: JournalEntryLeg[];
		reference: string;
		adjustmentType: "accrual" | "depreciation" | "correction" | "reclassification";
		description?: string;
		metadata?: Record<string, unknown>;
		idempotencyKey?: string;
		effectiveDate?: Date | string;
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

	const ledgerId = getLedgerId(ctx);

	const result = await withTransactionTimeout(ctx, async (tx) => {
		const t = createTableResolver(ctx.options.schema);

		// Idempotency check
		const idem = await checkIdempotencyKeyInTx(tx, {
			ledgerId,
			idempotencyKey: params.idempotencyKey,
			reference,
		});
		if (idem.alreadyProcessed && isValidCachedResult(idem.cachedResult)) {
			return idem.cachedResult as LedgerTransaction;
		}

		const correlationId = randomUUID();

		// Create adjustment transfer record (status = 'posted' directly)
		const txnRows = await tx.raw<RawTransferRow>(
			`INSERT INTO ${t("transfer")} (ledger_id, type, status, reference, amount, currency, description, correlation_id, metadata, posted_at, effective_date)
       VALUES ($1, $2, 'posted', $3, $4, $5, $6, $7, $8, NOW(), COALESCE($9::timestamptz, NOW()))
       RETURNING *`,
			[
				ledgerId,
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
				params.effectiveDate ?? null,
			],
		);
		const txnRecord = txnRows[0];
		if (!txnRecord) throw SummaError.internal("Failed to insert adjustment record");

		// Process each leg
		await processJournalLegs(
			tx,
			ctx,
			txnRecord,
			entries,
			ctx.options.currency,
			"adjustment",
			ledgerId,
		);

		const response = rawToTransactionResponse(txnRecord, "adjustment", ctx.options.currency);

		// Save idempotency key
		if (params.idempotencyKey) {
			await saveIdempotencyKeyInTx(tx, {
				ledgerId,
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
 * Reverse all account entries from an original transfer.
 * In v2, both user and system accounts use the unified entry table.
 */
async function reverseAccountEntries(
	tx: SummaTransactionAdapter,
	original: RawTransferRow,
	reversal: RawTransferRow,
	amount: number,
): Promise<void> {
	// Reverse user account entries
	if (original.destination_account_id) {
		await insertEntryAndUpdateBalance({
			tx,
			transferId: reversal.id,
			accountId: original.destination_account_id,
			entryType: "DEBIT",
			amount,
			currency: original.currency,
			isHotAccount: false,
		});
	}

	if (original.source_account_id) {
		await insertEntryAndUpdateBalance({
			tx,
			transferId: reversal.id,
			accountId: original.source_account_id,
			entryType: "CREDIT",
			amount,
			currency: original.currency,
			isHotAccount: false,
		});
	}
}
