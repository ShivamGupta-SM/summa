// =============================================================================
// MULTI-DESTINATION CREDIT HELPER
// =============================================================================
// Shared by hold-manager (commit) and transaction-manager (multiTransfer).
//
// v2 changes:
// - account_balance → account (unified table)
// - No more hot_account_entry table
// - System account entries use insertEntryAndUpdateBalance with isHotAccount=true
// - transactionId → transferId

import type { HoldDestination, SummaContext, SummaTransactionAdapter } from "@summa-ledger/core";
import { SummaError } from "@summa-ledger/core";
import { createTableResolver } from "@summa-ledger/core/db";
import { insertEntryAndUpdateBalance } from "./entry-balance.js";
import { getLedgerId } from "./ledger-helpers.js";
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
 * explicit amount gets the remainder.
 */
export async function creditMultiDestinations(
	tx: SummaTransactionAdapter,
	ctx: SummaContext,
	params: {
		transferId: string;
		currency: string;
		totalAmount: number;
		destinations: HoldDestination[];
	},
): Promise<CreditDestinationResult[]> {
	const t = createTableResolver(ctx.options.schema);
	const ledgerId = getLedgerId(ctx);
	const { transferId, currency, totalAmount, destinations } = params;

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
	if (remainder > 0 && remainderIndex === -1) {
		throw SummaError.invalidArgument(
			`Sum of destination amounts (${explicitSum}) is less than total amount (${totalAmount}) and no remainder destination specified`,
		);
	}

	const results: CreditDestinationResult[] = [];

	// Batch-fetch all system accounts upfront
	const systemAccountNames = [
		...new Set(destinations.map((d) => d.systemAccount).filter((name): name is string => !!name)),
	];
	const systemAccountMap = new Map<
		string,
		NonNullable<Awaited<ReturnType<typeof getSystemAccount>>>
	>();
	for (const name of systemAccountNames) {
		const sys = await getSystemAccount(ctx, name, ledgerId);
		if (!sys) throw SummaError.notFound(`System account ${name} not found`);
		systemAccountMap.set(name, sys);
	}

	const batchOps: Promise<unknown>[] = [];

	for (let i = 0; i < destinations.length; i++) {
		const dest = destinations[i]!;
		const destAmount = dest.amount ?? (i === remainderIndex ? remainder : 0);
		if (destAmount <= 0) continue;

		if (dest.systemAccount) {
			// System account destination — hot path (entry only, no balance update)
			const sys = systemAccountMap.get(dest.systemAccount);
			if (!sys) throw SummaError.notFound(`System account ${dest.systemAccount} not found`);

			batchOps.push(
				insertEntryAndUpdateBalance({
					tx,
					transferId,
					accountId: sys.id,
					entryType: "CREDIT",
					amount: destAmount,
					currency,
					isHotAccount: true,
				}),
			);

			results.push({
				systemAccountId: sys.id,
				systemAccount: dest.systemAccount,
				amount: destAmount,
			});
		} else if (dest.holderId) {
			// User account destination — lock and update balance
			const destRows = await tx.raw<{ id: string; status: string }>(
				`SELECT id, status FROM ${t("account")}
         WHERE ledger_id = $1 AND holder_id = $2 AND is_system = false
         LIMIT 1
         ${ctx.dialect.forUpdate()}`,
				[ledgerId, dest.holderId],
			);

			const destRow = destRows[0];
			if (!destRow) throw SummaError.notFound(`Destination account ${dest.holderId} not found`);
			if (destRow.status !== "active") {
				throw SummaError.conflict(`Destination account ${dest.holderId} is ${destRow.status}`);
			}

			// Credit entry + balance update
			await insertEntryAndUpdateBalance({
				tx,
				transferId,
				accountId: destRow.id,
				entryType: "CREDIT",
				amount: destAmount,
				currency,
				isHotAccount: false,
			});

			results.push({
				accountId: destRow.id,
				holderId: dest.holderId,
				amount: destAmount,
			});
		}
	}

	// Execute batched system account operations
	if (batchOps.length > 0) await Promise.all(batchOps);

	return results;
}
