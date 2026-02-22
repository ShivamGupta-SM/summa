// =============================================================================
// ENTRY + BALANCE UPDATE — Single Mutation Point (APPEND-ONLY)
// =============================================================================
// Every balance change in Summa flows through this function. Instead of UPDATE-ing
// account_balance rows, we INSERT a new account_balance_version row.
//
// For user accounts:
//   1. (Optional) SELECT ... FROM account_balance FOR UPDATE — skipped when caller
//      already locked via resolveAccountForUpdate (skipLock=true)
//   2. SELECT latest version FROM account_balance_version
//   3. INSERT entry_record + account_balance_version via CTE (single round-trip)
//
// For hot/system accounts: INSERT entry only (hot_account_entry batching is separate)

import type { SummaTransactionAdapter } from "@summa-ledger/core";
import { computeBalanceChecksum } from "@summa-ledger/core";
import { createTableResolver } from "@summa-ledger/core/db";
import { readLatestVersion } from "./sql-helpers.js";

// =============================================================================
// TYPES
// =============================================================================

export interface InsertEntryParams {
	/** The DB transaction handle */
	tx: SummaTransactionAdapter;

	/** transaction_record.id */
	transactionId: string;

	/** CREDIT or DEBIT */
	entryType: "CREDIT" | "DEBIT";

	/** Amount in minor units (positive integer) */
	amount: number;

	/** Currency code */
	currency: string;

	/** User account ID (mutually exclusive with systemAccountId) */
	accountId?: string | null;

	/** System account ID (mutually exclusive with accountId) */
	systemAccountId?: string | null;

	/** true for system/hot accounts — skips balance logic */
	isHotAccount: boolean;

	/** FX fields — only for cross-currency transfers */
	originalAmount?: number | null;
	originalCurrency?: string | null;
	exchangeRate?: number | null;

	/** Event ID that caused this change (for version tracking) */
	causedByEventId?: string | null;

	/**
	 * Skip the FOR UPDATE lock on account_balance. Set to true when the caller
	 * has already locked the account via resolveAccountForUpdate(). Saves one
	 * round-trip per call. Default: false (lock acquired here for safety).
	 */
	skipLock?: boolean;

	/**
	 * When true, also UPDATE the denormalized cached_* columns on account_balance
	 * in the same transaction. Eliminates LATERAL JOIN for balance reads.
	 * Controlled by ctx.options.advanced.useDenormalizedBalance.
	 */
	updateDenormalizedCache?: boolean;

	/**
	 * Lock acquisition mode. When "optimistic", the FOR UPDATE lock is skipped
	 * and conflict is detected via the UNIQUE(account_id, version) constraint.
	 */
	lockMode?: "wait" | "nowait" | "optimistic";

	/**
	 * Pre-fetched balance state from resolveAccountForUpdate(). When provided
	 * together with skipLock=true, the readLatestVersion() SELECT is skipped
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
 * Single mutation point: insert an entry_record and (for user accounts) insert
 * a new account_balance_version row with the updated state.
 *
 * For user accounts (isHotAccount=false):
 *   1. SELECT ... FOR UPDATE (unless skipLock=true — caller already locked)
 *   2. SELECT latest account_balance_version
 *   3. Compute balance_before, balance_after, new version
 *   4. CTE: INSERT entry_record + INSERT account_balance_version (one round-trip)
 *
 * For hot/system accounts (isHotAccount=true):
 *   Just INSERT the entry_record. Balance logic is handled by hot_account_entry batching.
 */
export async function insertEntryAndUpdateBalance(
	params: InsertEntryParams,
): Promise<InsertEntryResult> {
	const { tx, transactionId, entryType, amount, currency, isHotAccount } = params;
	const t = createTableResolver(params.tx.options?.schema ?? "@summa-ledger/summa");

	// --- HOT ACCOUNT PATH: just insert the entry, no balance logic ---
	if (isHotAccount) {
		await tx.raw(
			`INSERT INTO ${t("entry_record")} (transaction_id, system_account_id, entry_type, amount, currency, is_hot_account)
       VALUES ($1, $2, $3, $4, $5, $6)`,
			[transactionId, params.systemAccountId, entryType, amount, currency, true],
		);
		return { balanceBefore: null, balanceAfter: null, lockVersion: null };
	}

	// --- USER ACCOUNT PATH ---
	const accountId = params.accountId;
	if (!accountId) {
		throw new Error("accountId is required for non-hot-account entries");
	}

	// Step 1: Lock the immutable account_balance parent row (serialization point)
	// Skipped when the caller already locked via resolveAccountForUpdate()
	// Skipped in optimistic mode — conflict detected via UNIQUE(account_id, version) constraint
	const isOptimistic = params.lockMode === "optimistic";
	if (!params.skipLock && !isOptimistic) {
		await tx.raw(`SELECT id FROM ${t("account_balance")} WHERE id = $1 FOR UPDATE`, [accountId]);
	}

	// Step 2: Read latest version from account_balance_version.
	// Skipped when existingBalance is provided (caller already fetched via resolveAccountForUpdate).
	const current = params.existingBalance ?? (await readLatestVersion(tx, t, accountId));

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
	const hmacSecret = params.tx.options?.hmacSecret ?? null;
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

	// Step 4: CTE — INSERT entry_record + account_balance_version in one round-trip
	// The UNIQUE(account_id, version) constraint on account_balance_version acts as
	// optimistic lock: if a concurrent transaction inserted this version, this fails.
	const changeType = entryType === "CREDIT" ? "credit" : "debit";
	const hasFx = params.originalAmount != null;

	const entryCols = hasFx
		? "transaction_id, account_id, entry_type, amount, currency, is_hot_account, balance_before, balance_after, account_lock_version, original_amount, original_currency, exchange_rate"
		: "transaction_id, account_id, entry_type, amount, currency, is_hot_account, balance_before, balance_after, account_lock_version";

	const entryPlaceholders = hasFx
		? "$1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12"
		: "$1, $2, $3, $4, $5, $6, $7, $8, $9";

	const entryParams: unknown[] = hasFx
		? [
				transactionId,
				accountId,
				entryType,
				amount,
				currency,
				false,
				balanceBefore,
				balanceAfter,
				newVersion,
				params.originalAmount,
				params.originalCurrency,
				params.exchangeRate,
			]
		: [
				transactionId,
				accountId,
				entryType,
				amount,
				currency,
				false,
				balanceBefore,
				balanceAfter,
				newVersion,
			];

	// Version params start after entry params
	const vBase = entryParams.length;
	const versionParams = [
		accountId,
		newVersion,
		balanceAfter,
		newCreditBalance,
		newDebitBalance,
		Number(current.pending_debit),
		Number(current.pending_credit),
		current.status,
		checksum,
		current.freeze_reason,
		current.frozen_at,
		current.frozen_by,
		current.closed_at,
		current.closed_by,
		current.closure_reason,
		changeType,
		transactionId,
	];

	const vPlaceholders = versionParams.map((_, i) => `$${vBase + i + 1}`).join(", ");

	await tx.raw(
		`WITH new_entry AS (
       INSERT INTO ${t("entry_record")} (${entryCols})
       VALUES (${entryPlaceholders})
       RETURNING id
     )
     INSERT INTO ${t("account_balance_version")} (
       account_id, version, balance, credit_balance, debit_balance,
       pending_debit, pending_credit, status, checksum,
       freeze_reason, frozen_at, frozen_by,
       closed_at, closed_by, closure_reason,
       change_type, caused_by_transaction_id
     ) VALUES (${vPlaceholders})`,
		[...entryParams, ...versionParams],
	);

	// Update denormalized balance cache on account_balance (same transaction).
	// Eliminates the LATERAL JOIN for balance reads when enabled.
	if (params.updateDenormalizedCache) {
		await tx.raw(
			`UPDATE ${t("account_balance")} SET
			   cached_balance = $1,
			   cached_credit_balance = $2,
			   cached_debit_balance = $3,
			   cached_pending_debit = $4,
			   cached_pending_credit = $5,
			   cached_version = $6,
			   cached_status = $7,
			   cached_checksum = $8
			 WHERE id = $9`,
			[
				balanceAfter,
				newCreditBalance,
				newDebitBalance,
				Number(current.pending_debit),
				Number(current.pending_credit),
				newVersion,
				current.status,
				checksum,
				accountId,
			],
		);
	}

	return { balanceBefore, balanceAfter, lockVersion: newVersion };
}
