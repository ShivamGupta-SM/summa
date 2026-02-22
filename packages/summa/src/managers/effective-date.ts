// =============================================================================
// EFFECTIVE DATE — Point-in-time balance queries
// =============================================================================
// Computes account balance as of a given effective date by summing entries
// with effective_date <= the target date.

import type { SummaContext } from "@summa/core";
import { createTableResolver } from "@summa/core/db";
import { getLedgerId } from "./ledger-helpers.js";

export interface BalanceAsOf {
	balance: number;
	creditBalance: number;
	debitBalance: number;
	currency: string;
	asOf: string;
}

/**
 * Compute the balance of an account as of a given effective date.
 * Sums all entry_record rows with effective_date <= asOf.
 */
export async function getBalanceAsOf(
	ctx: SummaContext,
	accountId: string,
	asOf: Date | string,
): Promise<BalanceAsOf> {
	const ledgerId = getLedgerId(ctx);
	const t = createTableResolver(ctx.options.schema);

	const rows = await (ctx as SummaContext & { readAdapter: typeof ctx.adapter }).readAdapter.raw<{
		total_credits: string;
		total_debits: string;
		currency: string;
	}>(
		`SELECT
			COALESCE(SUM(CASE WHEN e.entry_type = 'CREDIT' THEN e.amount ELSE 0 END), 0) as total_credits,
			COALESCE(SUM(CASE WHEN e.entry_type = 'DEBIT' THEN e.amount ELSE 0 END), 0) as total_debits,
			a.currency
		FROM ${t("entry_record")} e
		JOIN ${t("account_balance")} a ON a.id = e.account_id
		WHERE e.account_id = $1
			AND a.ledger_id = $2
			AND e.effective_date <= $3::timestamptz`,
		[accountId, ledgerId, asOf],
	);

	const row = rows[0];
	const totalCredits = row ? Number(row.total_credits) : 0;
	const totalDebits = row ? Number(row.total_debits) : 0;
	const balance = totalCredits - totalDebits;
	const currency = row?.currency ?? ctx.options.currency;
	const asOfStr = asOf instanceof Date ? asOf.toISOString() : asOf;

	return {
		balance,
		creditBalance: totalCredits,
		debitBalance: totalDebits,
		currency,
		asOf: asOfStr,
	};
}
