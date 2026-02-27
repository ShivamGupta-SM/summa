// =============================================================================
// JOURNAL MANAGER -- N-Leg Journal Entries
// =============================================================================
// Arbitrary N debits + M credits in one atomic entry.
// Example: payroll with salary expense, PF, TDS — 5 legs in one entry.
//
// v2 changes:
// - transaction_record → transfer table
// - entries ARE events (no appendEvent)
// - status is a direct column on transfer

import { randomUUID } from "node:crypto";
import type { JournalEntryLeg, LedgerTransaction, SummaContext } from "@summa-ledger/core";
import { SummaError } from "@summa-ledger/core";
import { createTableResolver } from "@summa-ledger/core/db";
import { runAfterOperationHooks } from "../context/hooks.js";
import { withTransactionTimeout } from "../infrastructure/event-store.js";
import {
	checkIdempotencyKeyInTx,
	isValidCachedResult,
	saveIdempotencyKeyInTx,
} from "./idempotency.js";
import { getLedgerId } from "./ledger-helpers.js";
import type { RawTransferRow } from "./raw-types.js";
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
		effectiveDate?: Date | string;
	},
): Promise<LedgerTransaction> {
	const { entries, reference, description = "", metadata = {} } = params;

	if (!entries || entries.length < 2) {
		throw SummaError.invalidArgument("Journal entry requires at least 2 legs (debits and credits)");
	}

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

		// Create journal transfer record (status = 'posted' directly)
		const txnRows = await tx.raw<RawTransferRow>(
			`INSERT INTO ${t("transfer")} (ledger_id, type, status, reference, amount, currency, description, correlation_id, metadata, posted_at, effective_date)
       VALUES ($1, $2, 'posted', $3, $4, $5, $6, $7, $8, NOW(), COALESCE($9::timestamptz, NOW()))
       RETURNING *`,
			[
				ledgerId,
				"journal",
				reference,
				totalDebits,
				ctx.options.currency,
				description,
				correlationId,
				JSON.stringify({
					...metadata,
					type: "journal",
					entries,
				}),
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
