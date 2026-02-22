// =============================================================================
// JOURNAL MANAGER -- N-Leg Journal Entries
// =============================================================================
// Arbitrary N debits + M credits in one atomic entry.
// Example: payroll with salary expense, PF, TDS — 5 legs in one entry.

import { randomUUID } from "node:crypto";
import type { JournalEntryLeg, LedgerTransaction, SummaContext } from "@summa/core";
import { AGGREGATE_TYPES, SummaError, TRANSACTION_EVENTS } from "@summa/core";
import { createTableResolver } from "@summa/core/db";
import { runAfterOperationHooks } from "../context/hooks.js";
import { appendEvent, withTransactionTimeout } from "../infrastructure/event-store.js";
import {
	checkIdempotencyKeyInTx,
	isValidCachedResult,
	saveIdempotencyKeyInTx,
} from "./idempotency.js";
import { getLedgerId } from "./ledger-helpers.js";
import type { RawTransactionRow } from "./raw-types.js";
import { processJournalLegs, rawToTransactionResponse } from "./sql-helpers.js";

// =============================================================================
// JOURNAL ENTRY
// =============================================================================

export async function journalEntry(
	ctx: SummaContext,
	params: {
		entries: JournalEntryLeg[];
		reference: string;
		description?: string;
		metadata?: Record<string, unknown>;
		idempotencyKey?: string;
		/** Effective date for backdated transactions. Defaults to NOW(). */
		effectiveDate?: Date | string;
	},
): Promise<LedgerTransaction> {
	const { entries, reference, description = "", metadata = {} } = params;

	if (!entries || entries.length < 2) {
		throw SummaError.invalidArgument("Journal entry requires at least 2 legs (debits and credits)");
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
		else throw SummaError.invalidArgument("Invalid direction: must be debit or credit");

		if (!entry.holderId && !entry.systemAccount) {
			throw SummaError.invalidArgument("Each entry must specify either holderId or systemAccount");
		}
	}

	if (totalDebits !== totalCredits) {
		throw SummaError.invalidArgument(
			`Journal entries must balance: debits (${totalDebits}) !== credits (${totalCredits})`,
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

		// Create journal transaction record
		// source_account_id and destination_account_id are null for journal entries
		const txnRows = await tx.raw<RawTransactionRow>(
			`INSERT INTO ${t("transaction_record")} (type, reference, status, amount, currency, description, correlation_id, meta_data, posted_at, ledger_id, effective_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), $9, COALESCE($10::timestamptz, NOW()))
       RETURNING *`,
			[
				"journal",
				reference,
				"posted",
				totalDebits,
				ctx.options.currency,
				description,
				correlationId,
				JSON.stringify({
					...metadata,
					type: "journal",
					entries,
				}),
				ledgerId,
				params.effectiveDate ?? null,
			],
		);
		const txnRecord = txnRows[0]!;

		// Process each leg
		await processJournalLegs(
			tx,
			ctx,
			txnRecord,
			entries,
			ctx.options.currency,
			"journal",
			ledgerId,
		);

		// Event store
		await appendEvent(
			tx,
			{
				aggregateType: AGGREGATE_TYPES.TRANSACTION,
				aggregateId: txnRecord.id,
				eventType: TRANSACTION_EVENTS.POSTED,
				eventData: {
					postedAt: new Date().toISOString(),
					entries,
				},
				correlationId,
			},
			ctx.options.schema,
			ctx.options.advanced.hmacSecret,
			ledgerId,
		);

		const response = rawToTransactionResponse(txnRecord, "journal", ctx.options.currency);

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
		type: "transaction.journal",
		params: { entries, reference },
	});
	return result;
}
