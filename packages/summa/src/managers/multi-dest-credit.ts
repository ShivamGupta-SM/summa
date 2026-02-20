// =============================================================================
// MULTI-DESTINATION CREDIT HELPER
// =============================================================================
// Shared by hold-manager (commit) and transaction-manager (multiTransfer).

import type { HoldDestination, SummaContext, SummaTransactionAdapter } from "@summa/core";
import { SummaError } from "@summa/core";
import type { RawBalanceUpdateRow } from "./raw-types.js";
import { getSystemAccount } from "./system-accounts.js";

export interface CreditDestinationResult {
	accountId?: string;
	systemAccountId?: string;
	holderId?: string;
	systemAccount?: string;
	amount: number;
}

/**
 * Distributes committed amount across multiple destinations.
 * Each destination gets its specified amount; last destination without an
 * explicit amount gets the remainder. Creates proper entry_record for each.
 *
 * Returns resolved destination info so callers can emit outbox events / log transactions.
 */
export async function creditMultiDestinations(
	tx: SummaTransactionAdapter,
	ctx: SummaContext,
	params: {
		transactionId: string;
		currency: string;
		totalAmount: number;
		destinations: HoldDestination[];
	},
): Promise<CreditDestinationResult[]> {
	const { transactionId, currency, totalAmount, destinations } = params;

	// Calculate amounts: explicit amounts first, then remainder
	let explicitSum = 0;
	let remainderIndex = -1;

	for (let i = 0; i < destinations.length; i++) {
		const amt = destinations[i]?.amount;
		if (amt != null) {
			explicitSum += amt;
		} else {
			remainderIndex = i;
		}
	}

	const remainder = totalAmount - explicitSum;
	if (remainder < 0) {
		throw SummaError.invalidArgument(
			`Sum of destination amounts (${explicitSum}) exceeds commit amount (${totalAmount})`,
		);
	}

	const results: CreditDestinationResult[] = [];

	// Batch-fetch all system accounts upfront to avoid N+1 queries in the loop
	const systemAccountNames = [
		...new Set(destinations.map((d) => d.systemAccount).filter((name): name is string => !!name)),
	];
	const systemAccountMap = new Map<
		string,
		NonNullable<Awaited<ReturnType<typeof getSystemAccount>>>
	>();
	for (const name of systemAccountNames) {
		const sys = await getSystemAccount(ctx, name);
		if (!sys) throw SummaError.notFound(`System account ${name} not found`);
		systemAccountMap.set(name, sys);
	}

	// Collect entry records and hot account entries for batch insert
	const entryInserts: Promise<unknown>[] = [];
	const hotEntryInserts: Promise<unknown>[] = [];

	for (let i = 0; i < destinations.length; i++) {
		const dest = destinations[i]!;
		const destAmount = dest.amount ?? (i === remainderIndex ? remainder : 0);
		if (destAmount <= 0) continue;

		if (dest.systemAccount) {
			// System account destination -- hot account pattern
			const sys = systemAccountMap.get(dest.systemAccount);
			if (!sys) throw SummaError.notFound(`System account ${dest.systemAccount} not found`);

			hotEntryInserts.push(
				tx.raw(
					`INSERT INTO hot_account_entry (account_id, amount, entry_type, transaction_id, status)
           VALUES ($1, $2, $3, $4, $5)`,
					[sys.id, destAmount, "CREDIT", transactionId, "pending"],
				),
			);

			entryInserts.push(
				tx.raw(
					`INSERT INTO entry_record (transaction_id, system_account_id, entry_type, amount, currency, is_hot_account)
           VALUES ($1, $2, $3, $4, $5, $6)`,
					[transactionId, sys.id, "CREDIT", destAmount, currency, true],
				),
			);

			results.push({
				systemAccountId: sys.id,
				systemAccount: dest.systemAccount,
				amount: destAmount,
			});
		} else if (dest.holderId) {
			// User account destination -- lock inside tx to prevent crediting frozen/closed accounts
			const destRows = await tx.raw<{ id: string; status: string }>(
				`SELECT id, status FROM account_balance
         WHERE holder_id = $1
         LIMIT 1
         FOR UPDATE`,
				[dest.holderId],
			);

			const destRow = destRows[0];
			if (!destRow) throw SummaError.notFound(`Destination account ${dest.holderId} not found`);
			if (destRow.status !== "active") {
				throw SummaError.conflict(`Destination account ${dest.holderId} is ${destRow.status}`);
			}

			const creditUpdateRows = await tx.raw<RawBalanceUpdateRow>(
				`UPDATE account_balance
         SET balance = balance + $1,
             credit_balance = credit_balance + $1,
             lock_version = lock_version + 1,
             updated_at = NOW()
         WHERE id = $2
         RETURNING balance - $1 as balance_before, balance as balance_after, lock_version`,
				[destAmount, destRow.id],
			);

			const creditUpdate = creditUpdateRows[0];
			if (!creditUpdate) {
				throw SummaError.internal(`Failed to update destination account ${dest.holderId}`);
			}

			entryInserts.push(
				tx.raw(
					`INSERT INTO entry_record (transaction_id, account_id, entry_type, amount, currency, balance_before, balance_after, account_lock_version, is_hot_account)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
					[
						transactionId,
						destRow.id,
						"CREDIT",
						destAmount,
						currency,
						creditUpdate.balance_before,
						creditUpdate.balance_after,
						creditUpdate.lock_version,
						false,
					],
				),
			);

			results.push({
				accountId: destRow.id,
				holderId: dest.holderId,
				amount: destAmount,
			});
		}
	}

	// Batch insert all entry records
	await Promise.all([...entryInserts, ...hotEntryInserts]);

	return results;
}
