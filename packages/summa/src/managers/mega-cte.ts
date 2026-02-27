// =============================================================================
// MEGA CTE — Combine all transaction writes into a single SQL round-trip
// =============================================================================
// v2 reduces per-transaction writes from ~10 to ~5:
//   1. transfer INSERT (status is a column, no separate transaction_status table)
//   2. entry INSERT for user account (with hash chain)
//   3. entry INSERT for system account (hot path, no balance update)
//   4. account UPDATE for user account (balance + version + checksum)
//   5. (optional) outbox, idempotency
//
// Removed: transaction_status INSERT, account_balance_version INSERT,
//          hot_account_entry INSERT, ledger_event INSERT, velocity log INSERT

import type { SummaTransactionAdapter } from "@summa-ledger/core";
import { computeBalanceChecksum, computeHash } from "@summa-ledger/core";
import { createTableResolver } from "@summa-ledger/core/db";

// =============================================================================
// TYPES
// =============================================================================

export interface MegaCTEParams {
	tx: SummaTransactionAdapter;
	schema: string;
	ledgerId: string;
	hmacSecret: string | null;

	// Transfer fields
	txnType: "credit" | "debit";
	reference: string;
	amount: number;
	currency: string;
	description: string;
	metadata: Record<string, unknown>;
	correlationId: string;

	// Account fields (unified — no more system account FK columns)
	sourceAccountId: string | null;
	destinationAccountId: string | null;

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

	// System account entry (hot side)
	systemAccountId: string;
	systemEntryType: "CREDIT" | "DEBIT";

	// Previous hashes for chain continuity (looked up before calling mega CTE)
	userPrevHash: string | null;
	systemPrevHash: string | null;

	// Outbox
	outboxTopic: string;
	outboxPayload: Record<string, unknown>;

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
	transferId: string;
	createdAt: Date;
	effectiveDate: Date;
}

// =============================================================================
// BUILD AND EXECUTE MEGA CTE
// =============================================================================

/**
 * Executes all transaction writes (transfer, entry x2, account UPDATE,
 * outbox, idempotency) in a single SQL CTE round-trip.
 *
 * Returns the new transfer ID and creation timestamp.
 */
export async function executeMegaCTE(params: MegaCTEParams): Promise<MegaCTEResult> {
	const { tx, schema, ledgerId, hmacSecret } = params;
	const t = createTableResolver(schema);

	// Pre-compute checksum and entry hashes in-memory (CPU, not DB)
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

	// User entry hash (per-account chain)
	const userEntryData = {
		transferId: "__PENDING__", // placeholder — real ID comes from CTE
		accountId: params.userAccountId,
		entryType: params.userEntryType,
		amount: params.amount,
		currency: params.currency,
		balanceBefore: params.balanceBefore,
		balanceAfter: params.balanceAfter,
		version: params.newVersion,
	};
	const userHash = computeHash(params.userPrevHash, userEntryData, hmacSecret);

	// System entry hash (per-account chain, hot path)
	const systemEntryData = {
		transferId: "__PENDING__",
		accountId: params.systemAccountId,
		entryType: params.systemEntryType,
		amount: params.amount,
		currency: params.currency,
		isHot: true,
	};
	const systemHash = computeHash(params.systemPrevHash, systemEntryData, hmacSecret);

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

	// 1. new_transfer: INSERT transfer
	cteParts.push(`new_transfer AS (
    INSERT INTO ${t("transfer")} (
      ledger_id, type, status, reference, amount, currency, description,
      source_account_id, destination_account_id,
      correlation_id, metadata, posted_at, effective_date
    ) VALUES (
      ${p(ledgerId)}, ${p(params.txnType)}, 'posted', ${p(params.reference)}, ${p(params.amount)}, ${p(params.currency)}, ${p(params.description)},
      ${p(params.sourceAccountId)}, ${p(params.destinationAccountId)},
      ${p(params.correlationId)}, ${p(JSON.stringify(params.metadata))},
      NOW(), COALESCE(${p(params.effectiveDate ?? null)}::timestamptz, NOW())
    ) RETURNING id, created_at, effective_date
  )`);

	// 2. new_entry: INSERT entry for user account (with hash chain)
	const entryColsBase =
		"transfer_id, account_id, entry_type, amount, currency, balance_before, balance_after, account_version, sequence_number, hash, prev_hash, effective_date";
	const entryCols = hasFx
		? `${entryColsBase}, original_amount, original_currency, exchange_rate`
		: entryColsBase;

	const entryValsBase = `id, ${p(params.userAccountId)}, ${p(params.userEntryType)}, ${p(params.amount)}, ${p(params.currency)}, ${p(params.balanceBefore)}, ${p(params.balanceAfter)}, ${p(params.newVersion)}, nextval('${t("entry")}_sequence_number_seq'), ${p(userHash)}, ${p(params.userPrevHash)}, effective_date`;
	const entryVals = hasFx
		? `${entryValsBase}, ${p(params.originalAmount)}, ${p(params.originalCurrency)}, ${p(params.exchangeRate)}`
		: entryValsBase;

	cteParts.push(`new_entry AS (
    INSERT INTO ${t("entry")} (${entryCols})
    SELECT ${entryVals} FROM new_transfer
    RETURNING id
  )`);

	// 3. new_sys_entry: INSERT entry for system account (hot path, no balance_before/after)
	cteParts.push(`new_sys_entry AS (
    INSERT INTO ${t("entry")} (transfer_id, account_id, entry_type, amount, currency, sequence_number, hash, prev_hash, effective_date)
    SELECT id, ${p(params.systemAccountId)}, ${p(params.systemEntryType)}, ${p(params.amount)}, ${p(params.currency)}, nextval('${t("entry")}_sequence_number_seq'), ${p(systemHash)}, ${p(params.systemPrevHash)}, effective_date
    FROM new_transfer
  )`);

	// 4. update_account: UPDATE account balance + version + checksum
	cteParts.push(`update_account AS (
    UPDATE ${t("account")} SET
      balance = ${p(params.balanceAfter)},
      credit_balance = ${p(params.newCreditBalance)},
      debit_balance = ${p(params.newDebitBalance)},
      version = ${p(params.newVersion)},
      checksum = ${p(checksum)}
    WHERE id = ${p(params.userAccountId)} AND version = ${p(Number(params.newVersion) - 1)}
  )`);

	// 5. new_outbox: INSERT outbox event
	cteParts.push(`new_outbox AS (
    INSERT INTO ${t("outbox")} (topic, payload)
    VALUES (${p(params.outboxTopic)}, ${p(JSON.stringify(params.outboxPayload))})
  )`);

	// 6. new_idem: UPSERT idempotency key (optional)
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
    SELECT id, created_at, effective_date FROM new_transfer`;

	const rows = await tx.raw<{
		id: string;
		created_at: string | Date;
		effective_date: string | Date;
	}>(sql, sqlParams);
	const row = rows[0];
	if (!row) {
		throw new Error("Mega CTE failed to return transfer record");
	}

	return {
		transferId: row.id,
		createdAt: new Date(row.created_at),
		effectiveDate: new Date(row.effective_date),
	};
}
