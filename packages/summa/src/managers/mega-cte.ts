// =============================================================================
// MEGA CTE — Combine all transaction writes into a single SQL round-trip
// =============================================================================
// Reduces per-transaction sequential DB round-trips from ~6-7 to 1 (plus 1
// for the denormalized cache UPDATE). All INSERTs happen atomically via a
// PostgreSQL CTE chain.
//
// For credit/debit transactions where aggregate_type = "transaction", each
// transaction is its own event aggregate (version=1, prevHash=null), so no
// prior event lookup is needed.

import { randomUUID } from "node:crypto";
import type { SummaTransactionAdapter } from "@summa/core";
import { computeBalanceChecksum, computeHash } from "@summa/core";
import { createTableResolver } from "@summa/core/db";

// =============================================================================
// TYPES
// =============================================================================

export interface MegaCTEParams {
	tx: SummaTransactionAdapter;
	schema: string;
	ledgerId: string;
	hmacSecret: string | null;

	// Transaction record fields
	txnType: "credit" | "debit";
	reference: string;
	amount: number;
	currency: string;
	description: string;
	metadata: Record<string, unknown>;
	correlationId: string;

	// Account fields
	sourceAccountId: string | null;
	destinationAccountId: string | null;
	sourceSystemAccountId: string | null;
	destinationSystemAccountId: string | null;

	// Entry + balance update (user account side)
	userAccountId: string;
	userEntryType: "CREDIT" | "DEBIT";
	balanceBefore: number;
	balanceAfter: number;
	newVersion: number;
	newCreditBalance: number;
	newDebitBalance: number;
	pendingDebit: number;
	pendingCredit: number;
	accountStatus: string;
	freezeReason: string | null;
	frozenAt: string | Date | null;
	frozenBy: string | null;
	closedAt: string | Date | null;
	closedBy: string | null;
	closureReason: string | null;

	// System account entry (hot side)
	systemAccountId: string;
	systemEntryType: "CREDIT" | "DEBIT";

	// Event store
	enableEventSourcing: boolean;
	eventData: Record<string, unknown>;

	// Outbox
	outboxTopic: string;
	outboxPayload: Record<string, unknown>;

	// Velocity log
	velocityAccountId: string;
	velocityTxnType: "credit" | "debit";

	// Idempotency (optional)
	idempotencyKey?: string;
	idempotencyResultData?: unknown;
	idempotencyTTLSeconds?: number;

	// FX fields (optional)
	originalAmount?: number | null;
	originalCurrency?: string | null;
	exchangeRate?: number | null;

	// Effective date (optional — defaults to NOW() in SQL)
	effectiveDate?: Date | string | null;
}

export interface MegaCTEResult {
	transactionId: string;
	createdAt: Date;
	effectiveDate: Date;
}

// =============================================================================
// BUILD AND EXECUTE MEGA CTE
// =============================================================================

/**
 * Executes all transaction writes (transaction_record, transaction_status,
 * entry_record, account_balance_version, hot entries, ledger_event, outbox,
 * velocity log, idempotency key) in a single SQL CTE round-trip.
 *
 * Returns the new transaction ID and creation timestamp.
 */
export async function executeMegaCTE(params: MegaCTEParams): Promise<MegaCTEResult> {
	const { tx, schema, ledgerId, hmacSecret } = params;
	const t = createTableResolver(schema);

	// Pre-compute checksum and event hash in-memory (CPU, not DB)
	const checksum = computeBalanceChecksum(
		{
			balance: params.balanceAfter,
			creditBalance: params.newCreditBalance,
			debitBalance: params.newDebitBalance,
			pendingDebit: params.pendingDebit,
			pendingCredit: params.pendingCredit,
			lockVersion: params.newVersion,
		},
		hmacSecret,
	);

	// For aggregate_type = "transaction", each transaction is its own aggregate.
	// Version is always 1, prevHash is always null.
	const eventHash = params.enableEventSourcing
		? computeHash(null, params.eventData, hmacSecret)
		: null;

	const eventId = randomUUID();
	const changeType = params.userEntryType === "CREDIT" ? "credit" : "debit";
	const signedHotAmount = params.systemEntryType === "DEBIT" ? -params.amount : params.amount;

	const hasFx = params.originalAmount != null;

	// Build parameter array
	const sqlParams: unknown[] = [];
	let pIdx = 0;
	const p = (val: unknown): string => {
		sqlParams.push(val);
		return `$${++pIdx}`;
	};

	// --- Build CTE parts ---
	const cteParts: string[] = [];

	// 1. new_txn: INSERT transaction_record
	cteParts.push(`new_txn AS (
    INSERT INTO ${t("transaction_record")} (
      type, reference, amount, currency, description,
      source_account_id, destination_account_id,
      source_system_account_id, destination_system_account_id,
      correlation_id, meta_data, ledger_id, effective_date
    ) VALUES (
      ${p(params.txnType)}, ${p(params.reference)}, ${p(params.amount)}, ${p(params.currency)}, ${p(params.description)},
      ${p(params.sourceAccountId)}, ${p(params.destinationAccountId)},
      ${p(params.sourceSystemAccountId)}, ${p(params.destinationSystemAccountId)},
      ${p(params.correlationId)}, ${p(JSON.stringify(params.metadata))}, ${p(ledgerId)},
      COALESCE(${p(params.effectiveDate ?? null)}::timestamptz, NOW())
    ) RETURNING id, created_at, effective_date
  )`);

	// 2. new_status: INSERT transaction_status
	cteParts.push(`new_status AS (
    INSERT INTO ${t("transaction_status")} (transaction_id, status, posted_at)
    SELECT id, 'posted', NOW() FROM new_txn
  )`);

	// 3. new_entry: INSERT entry_record for user account
	const entryColsBase =
		"transaction_id, account_id, entry_type, amount, currency, is_hot_account, balance_before, balance_after, account_lock_version, effective_date";
	const entryCols = hasFx
		? `${entryColsBase}, original_amount, original_currency, exchange_rate`
		: entryColsBase;

	const entryValsBase = `id, ${p(params.userAccountId)}, ${p(params.userEntryType)}, ${p(params.amount)}, ${p(params.currency)}, false, ${p(params.balanceBefore)}, ${p(params.balanceAfter)}, ${p(params.newVersion)}, effective_date`;
	const entryVals = hasFx
		? `${entryValsBase}, ${p(params.originalAmount)}, ${p(params.originalCurrency)}, ${p(params.exchangeRate)}`
		: entryValsBase;

	cteParts.push(`new_entry AS (
    INSERT INTO ${t("entry_record")} (${entryCols})
    SELECT ${entryVals} FROM new_txn
    RETURNING id
  )`);

	// 4. new_version: INSERT account_balance_version
	cteParts.push(`new_version AS (
    INSERT INTO ${t("account_balance_version")} (
      account_id, version, balance, credit_balance, debit_balance,
      pending_debit, pending_credit, status, checksum,
      freeze_reason, frozen_at, frozen_by,
      closed_at, closed_by, closure_reason,
      change_type, caused_by_transaction_id
    ) SELECT
      ${p(params.userAccountId)}, ${p(params.newVersion)}, ${p(params.balanceAfter)},
      ${p(params.newCreditBalance)}, ${p(params.newDebitBalance)},
      ${p(params.pendingDebit)}, ${p(params.pendingCredit)},
      ${p(params.accountStatus)}, ${p(checksum)},
      ${p(params.freezeReason)}, ${p(params.frozenAt)}, ${p(params.frozenBy)},
      ${p(params.closedAt)}, ${p(params.closedBy)}, ${p(params.closureReason)},
      ${p(changeType)}, id
    FROM new_txn
  )`);

	// 5. new_hot_entry: INSERT entry_record for system account (hot)
	cteParts.push(`new_hot_entry AS (
    INSERT INTO ${t("entry_record")} (transaction_id, system_account_id, entry_type, amount, currency, is_hot_account, effective_date)
    SELECT id, ${p(params.systemAccountId)}, ${p(params.systemEntryType)}, ${p(params.amount)}, ${p(params.currency)}, true, effective_date
    FROM new_txn
  )`);

	// 6. new_hot_account: INSERT hot_account_entry
	cteParts.push(`new_hot_account AS (
    INSERT INTO ${t("hot_account_entry")} (account_id, amount, entry_type, transaction_id, status)
    SELECT ${p(params.systemAccountId)}, ${p(signedHotAmount)}, ${p(params.systemEntryType)}, id, 'pending'
    FROM new_txn
  )`);

	// 7. new_event: INSERT ledger_event (if event sourcing enabled)
	if (params.enableEventSourcing) {
		cteParts.push(`new_event AS (
      INSERT INTO ${t("ledger_event")} (
        id, ledger_id, aggregate_type, aggregate_id, aggregate_version,
        event_type, event_data, correlation_id, hash, prev_hash
      ) SELECT
        ${p(eventId)}, ${p(ledgerId)}, 'transaction', id, 1,
        'transaction:posted', ${p(JSON.stringify(params.eventData))},
        ${p(params.correlationId)}, ${p(eventHash)}, NULL
      FROM new_txn
    )`);
	}

	// 8. new_outbox: INSERT outbox event
	cteParts.push(`new_outbox AS (
    INSERT INTO ${t("outbox")} (topic, payload)
    VALUES (${p(params.outboxTopic)}, ${p(JSON.stringify(params.outboxPayload))})
  )`);

	// 9. new_velocity: INSERT velocity log
	cteParts.push(`new_velocity AS (
    INSERT INTO ${t("account_transaction_log")} (account_id, ledger_txn_id, txn_type, amount, category, reference)
    SELECT ${p(params.velocityAccountId)}, id, ${p(params.velocityTxnType)}, ${p(params.amount)}, ${p((params.metadata as Record<string, unknown>).category ?? params.velocityTxnType)}, ${p(params.reference)}
    FROM new_txn
  )`);

	// 10. new_idem: UPSERT idempotency key (optional)
	if (params.idempotencyKey) {
		const ttl = params.idempotencyTTLSeconds ?? 86400;
		cteParts.push(`new_idem AS (
      INSERT INTO ${t("idempotency_key")} (ledger_id, key, reference, result_data, expires_at)
      VALUES (${p(ledgerId)}, ${p(params.idempotencyKey)}, ${p(params.reference)}, ${p(JSON.stringify(params.idempotencyResultData))}, NOW() + INTERVAL '1 second' * ${p(ttl)})
      ON CONFLICT (ledger_id, key) DO UPDATE
      SET result_data = EXCLUDED.result_data,
          reference = EXCLUDED.reference,
          expires_at = EXCLUDED.expires_at
    )`);
	}

	// Assemble final SQL
	const sql = `WITH ${cteParts.join(",\n")}
    SELECT id, created_at, effective_date FROM new_txn`;

	const rows = await tx.raw<{
		id: string;
		created_at: string | Date;
		effective_date: string | Date;
	}>(sql, sqlParams);
	const row = rows[0];
	if (!row) {
		throw new Error("Mega CTE failed to return transaction record");
	}

	return {
		transactionId: row.id,
		createdAt: new Date(row.created_at),
		effectiveDate: new Date(row.effective_date),
	};
}

// =============================================================================
// DENORMALIZED CACHE UPDATE (separate from CTE due to trigger)
// =============================================================================

/**
 * Update the denormalized cached_* columns on account_balance.
 * Must be called separately from the mega CTE because account_balance has a
 * column-aware immutability trigger that blocks INSERTs from modifying it.
 */
export async function updateDenormalizedCache(
	tx: SummaTransactionAdapter,
	schema: string,
	accountId: string,
	data: {
		balance: number;
		creditBalance: number;
		debitBalance: number;
		pendingDebit: number;
		pendingCredit: number;
		version: number;
		status: string;
		checksum: string;
	},
): Promise<void> {
	const t = createTableResolver(schema);
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
			data.balance,
			data.creditBalance,
			data.debitBalance,
			data.pendingDebit,
			data.pendingCredit,
			data.version,
			data.status,
			data.checksum,
			accountId,
		],
	);
}
