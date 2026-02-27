// =============================================================================
// ENTRY + BALANCE UPDATE — Single Mutation Point
// =============================================================================
// Every balance change in Summa flows through this function.
//
// For user accounts:
//   1. (Optional) SELECT ... FROM account FOR UPDATE — skipped when caller
//      already locked via resolveAccountForUpdate (skipLock=true)
//   2. READ current balance from account row
//   3. CTE: INSERT entry (with hash chain) + UPDATE account balance (single round-trip)
//
// For hot/system accounts: INSERT entry only (batch flush updates balance later)

import type { SummaTransactionAdapter } from "@summa-ledger/core";
import { computeBalanceChecksum, computeHash } from "@summa-ledger/core";
import { createTableResolver } from "@summa-ledger/core/db";
import { readAccountBalance } from "./sql-helpers.js";

// =============================================================================
// TYPES
// =============================================================================

export interface InsertEntryParams {
	/** The DB transaction handle */
	tx: SummaTransactionAdapter;

	/** transfer.id */
	transferId: string;

	/** CREDIT or DEBIT */
	entryType: "CREDIT" | "DEBIT";

	/** Amount in minor units (positive integer) */
	amount: number;

	/** Currency code */
	currency: string;

	/** Account ID (unified — works for both user and system accounts) */
	accountId: string;

	/** true for system/hot accounts — skips balance update */
	isHotAccount: boolean;

	/** FX fields — only for cross-currency transfers */
	originalAmount?: number | null;
	originalCurrency?: string | null;
	exchangeRate?: number | null;

	/**
	 * Skip the FOR UPDATE lock on account. Set to true when the caller
	 * has already locked the account via resolveAccountForUpdate(). Saves one
	 * round-trip per call. Default: false (lock acquired here for safety).
	 */
	skipLock?: boolean;

	/**
	 * Lock acquisition mode. When "optimistic", the FOR UPDATE lock is skipped
	 * and conflict is detected via the UNIQUE(account_id, account_version) constraint.
	 */
	lockMode?: "wait" | "nowait" | "optimistic";

	/**
	 * Pre-fetched balance state from resolveAccountForUpdate(). When provided
	 * together with skipLock=true, the readAccountBalance() SELECT is skipped
	 * entirely — saving one DB round-trip per transaction.
	 */
	existingBalance?: {
		version: number;
		balance: number;
		credit_balance: number;
		debit_balance: number;
		pending_debit: number;
		pending_credit: number;
		status: string;
		freeze_reason: string | null;
		frozen_at: string | Date | null;
		frozen_by: string | null;
		closed_at: string | Date | null;
		closed_by: string | null;
		closure_reason: string | null;
	};
}

export interface InsertEntryResult {
	balanceBefore: number | null;
	balanceAfter: number | null;
	lockVersion: number | null;
}

// =============================================================================
// CORE FUNCTION
// =============================================================================

/**
 * Single mutation point: insert an entry (with hash chain) and (for user accounts)
 * update the account balance in-place.
 *
 * For user accounts (isHotAccount=false):
 *   1. SELECT ... FOR UPDATE (unless skipLock=true)
 *   2. Read current balance from account row
 *   3. Compute entry hash (per-account chain)
 *   4. CTE: INSERT entry + UPDATE account (one round-trip)
 *
 * For hot/system accounts (isHotAccount=true):
 *   Just INSERT the entry. Balance update is handled by batch flush.
 */
export async function insertEntryAndUpdateBalance(
	params: InsertEntryParams,
): Promise<InsertEntryResult> {
	const { tx, transferId, entryType, amount, currency, isHotAccount, accountId } = params;
	const t = createTableResolver(params.tx.options?.schema ?? "summa");
	const hmacSecret = params.tx.options?.hmacSecret ?? null;

	// --- HOT ACCOUNT PATH: just insert the entry, no balance update ---
	if (isHotAccount) {
		// Get the previous hash for this account's chain
		const prevRows = await tx.raw<{ hash: string }>(
			`SELECT hash FROM ${t("entry")} WHERE account_id = $1 ORDER BY sequence_number DESC LIMIT 1`,
			[accountId],
		);
		const prevHash = prevRows[0]?.hash ?? null;

		// Compute entry hash
		const entryData = { transferId, accountId, entryType, amount, currency, isHot: true };
		const hash = computeHash(prevHash, entryData, hmacSecret);

		await tx.raw(
			`INSERT INTO ${t("entry")} (
				transfer_id, account_id, entry_type, amount, currency,
				sequence_number, hash, prev_hash, effective_date
			) VALUES (
				$1, $2, $3, $4, $5,
				nextval('${t("entry")}_sequence_number_seq'), $6, $7, NOW()
			)`,
			[transferId, accountId, entryType, amount, currency, hash, prevHash],
		);
		return { balanceBefore: null, balanceAfter: null, lockVersion: null };
	}

	// --- USER ACCOUNT PATH ---

	// Step 1: Lock the account row (serialization point)
	const isOptimistic = params.lockMode === "optimistic";
	if (!params.skipLock && !isOptimistic) {
		await tx.raw(`SELECT id FROM ${t("account")} WHERE id = $1 FOR UPDATE`, [accountId]);
	}

	// Step 2: Read current balance from account
	const current = params.existingBalance ?? (await readAccountBalance(tx, t, accountId));

	// Step 3: Compute derived fields
	const balanceBefore = Number(current.balance);
	const balanceAfter = entryType === "CREDIT" ? balanceBefore + amount : balanceBefore - amount;
	const newVersion = Number(current.version) + 1;

	const newCreditBalance =
		entryType === "CREDIT"
			? Number(current.credit_balance) + amount
			: Number(current.credit_balance);
	const newDebitBalance =
		entryType === "DEBIT" ? Number(current.debit_balance) + amount : Number(current.debit_balance);

	// Compute balance checksum for tamper detection
	const checksum = computeBalanceChecksum(
		{
			balance: balanceAfter,
			creditBalance: newCreditBalance,
			debitBalance: newDebitBalance,
			pendingDebit: Number(current.pending_debit),
			pendingCredit: Number(current.pending_credit),
			lockVersion: newVersion,
		},
		hmacSecret,
	);

	// Get previous hash for this account's chain
	const prevRows = await tx.raw<{ hash: string }>(
		`SELECT hash FROM ${t("entry")} WHERE account_id = $1 ORDER BY sequence_number DESC LIMIT 1`,
		[accountId],
	);
	const prevHash = prevRows[0]?.hash ?? null;

	// Compute entry hash
	const entryData = {
		transferId,
		accountId,
		entryType,
		amount,
		currency,
		balanceBefore,
		balanceAfter,
		version: newVersion,
	};
	const hash = computeHash(prevHash, entryData, hmacSecret);

	// Step 4: CTE — INSERT entry + UPDATE account in one round-trip
	// The UNIQUE(account_id, account_version) constraint on entry acts as
	// optimistic lock: if a concurrent transaction inserted this version, this fails.
	const hasFx = params.originalAmount != null;

	const sqlParams: unknown[] = [];
	let pIdx = 0;
	const p = (val: unknown): string => {
		sqlParams.push(val);
		return `$${++pIdx}`;
	};

	const entryCols = [
		"transfer_id", "account_id", "entry_type", "amount", "currency",
		"balance_before", "balance_after", "account_version",
		"sequence_number", "hash", "prev_hash",
	];
	const entryVals = [
		p(transferId), p(accountId), p(entryType), p(amount), p(currency),
		p(balanceBefore), p(balanceAfter), p(newVersion),
		`nextval('${t("entry")}_sequence_number_seq')`, p(hash), p(prevHash),
	];

	if (hasFx) {
		entryCols.push("original_amount", "original_currency", "exchange_rate");
		entryVals.push(p(params.originalAmount), p(params.originalCurrency), p(params.exchangeRate));
	}

	// Account UPDATE params
	const pBalAfter = p(balanceAfter);
	const pCreditBal = p(newCreditBalance);
	const pDebitBal = p(newDebitBalance);
	const pNewVer = p(newVersion);
	const pChecksum = p(checksum);
	const pAccId = p(accountId);
	const pCurVer = p(Number(current.version));

	await tx.raw(
		`WITH new_entry AS (
       INSERT INTO ${t("entry")} (${entryCols.join(", ")})
       VALUES (${entryVals.join(", ")})
       RETURNING id
     )
     UPDATE ${t("account")} SET
       balance = ${pBalAfter},
       credit_balance = ${pCreditBal},
       debit_balance = ${pDebitBal},
       version = ${pNewVer},
       checksum = ${pChecksum}
     WHERE id = ${pAccId} AND version = ${pCurVer}`,
		sqlParams,
	);

	return { balanceBefore, balanceAfter, lockVersion: newVersion };
}
