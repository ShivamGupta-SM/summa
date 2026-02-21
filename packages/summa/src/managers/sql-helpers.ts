// =============================================================================
// SQL HELPERS — Shared SQL patterns for manager operations
// =============================================================================
// Extracted from hold-manager, correction-manager, transaction-manager, and
// journal-manager to eliminate duplication.

import type {
	JournalEntryLeg,
	LedgerTransaction,
	SummaContext,
	SummaTransactionAdapter,
	TransactionStatus,
	TransactionType,
} from "@summa/core";
import { minorToDecimal, SummaError } from "@summa/core";
import { createTableResolver } from "@summa/core/db";
import { insertEntryAndUpdateBalance } from "./entry-balance.js";
import { logTransactionInTx } from "./limit-manager.js";
import type { LatestVersion, RawTransactionRow } from "./raw-types.js";
import { getSystemAccount } from "./system-accounts.js";

// =============================================================================
// TRANSACTION SQL
// =============================================================================

/** Build SQL to select transaction_record joined with latest transaction_status. */
export function txnWithStatusSql(t: (name: string) => string): string {
	return `SELECT tr.*, ts.status, ts.committed_amount, ts.refunded_amount, ts.posted_at
FROM ${t("transaction_record")} tr
JOIN LATERAL (
  SELECT status, committed_amount, refunded_amount, posted_at
  FROM ${t("transaction_status")}
  WHERE transaction_id = tr.id
  ORDER BY created_at DESC
  LIMIT 1
) ts ON true`;
}

// =============================================================================
// RAW ROW → RESPONSE MAPPING
// =============================================================================

/** Convert a raw transaction row (with joined status) to the public LedgerTransaction shape. */
export function rawToTransactionResponse(
	row: RawTransactionRow,
	type: TransactionType,
	currency: string,
): LedgerTransaction {
	return {
		id: row.id,
		reference: row.reference,
		type,
		status: row.status as TransactionStatus,
		amount: Number(row.amount),
		amountDecimal: minorToDecimal(Number(row.amount), currency),
		currency: row.currency,
		description: row.description ?? "",
		sourceAccountId: row.source_account_id,
		destinationAccountId: row.destination_account_id,
		correlationId: row.correlation_id,
		isReversal: row.is_reversal,
		parentId: row.parent_id,
		metadata: (() => {
			const raw = (row.meta_data ?? {}) as Record<string, unknown>;
			const {
				category: _c,
				holderId: _h,
				holderType: _ht,
				destinations: _d,
				...userMetadata
			} = raw;
			return userMetadata;
		})(),
		createdAt:
			row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
		postedAt: row.posted_at
			? row.posted_at instanceof Date
				? row.posted_at.toISOString()
				: String(row.posted_at)
			: null,
	};
}

// =============================================================================
// JOURNAL LEGS PROCESSING
// =============================================================================

interface ResolvedLeg {
	leg: JournalEntryLeg;
	accountId: string | null;
	systemAccountId: string | null;
	isSystemAccount: boolean;
}

/**
 * Process journal entry legs: resolve accounts, update balances, create entry records.
 * Accounts are locked in deterministic order (sorted by ID) to prevent deadlocks.
 *
 * Used by both journal-manager (category="journal") and correction-manager (category="adjustment").
 */
export async function processJournalLegs(
	tx: SummaTransactionAdapter,
	ctx: SummaContext,
	txnRecord: RawTransactionRow,
	legs: JournalEntryLeg[],
	currency: string,
	category: string,
): Promise<void> {
	const t = createTableResolver(ctx.options.schema);

	const resolved: ResolvedLeg[] = [];

	// Batch resolve system accounts
	const systemAccountNames = [
		...new Set(legs.map((l) => l.systemAccount).filter((n): n is string => !!n)),
	];
	const systemAccountMap = new Map<string, { id: string }>();
	for (const name of systemAccountNames) {
		const sys = await getSystemAccount(ctx, name);
		if (!sys) throw SummaError.notFound(`System account "${name}" not found`);
		systemAccountMap.set(name, sys);
	}

	for (const leg of legs) {
		if (leg.systemAccount) {
			const sys = systemAccountMap.get(leg.systemAccount);
			if (!sys) throw SummaError.notFound(`System account "${leg.systemAccount}" not found`);
			resolved.push({ leg, accountId: null, systemAccountId: sys.id, isSystemAccount: true });
		} else if (leg.holderId) {
			resolved.push({ leg, accountId: null, systemAccountId: null, isSystemAccount: false });
		}
	}

	// Resolve and lock user accounts in deterministic order to prevent deadlocks
	const holderIds = [
		...new Set(resolved.filter((r) => !r.isSystemAccount).map((r) => r.leg.holderId as string)),
	];
	holderIds.sort();

	const holderToAccount = new Map<string, { id: string; status: string }>();
	for (const holderId of holderIds) {
		// Lock immutable parent, then read latest status from version
		const parentRows = await tx.raw<{ id: string }>(
			`SELECT id FROM ${t("account_balance")} WHERE holder_id = $1 LIMIT 1 ${ctx.dialect.forUpdate()}`,
			[holderId],
		);
		const parentRow = parentRows[0];
		if (!parentRow) throw SummaError.notFound(`Account for holder "${holderId}" not found`);

		const statusRows = await tx.raw<{ status: string }>(
			`SELECT status FROM ${t("account_balance_version")}
       WHERE account_id = $1 ORDER BY version DESC LIMIT 1`,
			[parentRow.id],
		);
		const statusRow = statusRows[0];
		if (!statusRow) throw SummaError.internal(`No version for account ${parentRow.id}`);
		if (statusRow.status !== "active") {
			throw SummaError.conflict(`Account for holder "${holderId}" is ${statusRow.status}`);
		}
		holderToAccount.set(holderId, { id: parentRow.id, status: statusRow.status });
	}

	// Fill in resolved account IDs
	for (const r of resolved) {
		if (!r.isSystemAccount && r.leg.holderId) {
			const acct = holderToAccount.get(r.leg.holderId);
			if (acct) r.accountId = acct.id;
		}
	}

	// Process each leg
	// User account entries are sequential (SELECT+INSERT+UPDATE per entry)
	// Hot entries, outbox, and logs are batched
	const batchOps: Promise<unknown>[] = [];

	for (const r of resolved) {
		const { leg } = r;

		const entryType = leg.direction === "debit" ? ("DEBIT" as const) : ("CREDIT" as const);

		if (r.isSystemAccount && r.systemAccountId) {
			const hotAmount = entryType === "DEBIT" ? -leg.amount : leg.amount;
			batchOps.push(
				tx.raw(
					`INSERT INTO ${t("hot_account_entry")} (account_id, amount, entry_type, transaction_id, status)
           VALUES ($1, $2, $3, $4, $5)`,
					[r.systemAccountId, hotAmount, entryType, txnRecord.id, "pending"],
				),
			);
			batchOps.push(
				insertEntryAndUpdateBalance({
					tx,
					transactionId: txnRecord.id,
					systemAccountId: r.systemAccountId,
					entryType,
					amount: leg.amount,
					currency,
					isHotAccount: true,
				}),
			);
		} else if (r.accountId) {
			// User account — sequential entry + balance update
			await insertEntryAndUpdateBalance({
				tx,
				transactionId: txnRecord.id,
				accountId: r.accountId,
				entryType,
				amount: leg.amount,
				currency,
				isHotAccount: false,
				updateDenormalizedCache: ctx.options.advanced.useDenormalizedBalance,
			});

			const topic = entryType === "DEBIT" ? "ledger-account-debited" : "ledger-account-credited";
			batchOps.push(
				logTransactionInTx(tx, {
					accountId: r.accountId,
					ledgerTxnId: txnRecord.id,
					txnType: entryType === "DEBIT" ? "debit" : "credit",
					amount: leg.amount,
					category,
					reference: txnRecord.reference,
				}),
			);
			batchOps.push(
				tx.raw(`INSERT INTO ${t("outbox")} (topic, payload) VALUES ($1, $2)`, [
					topic,
					JSON.stringify({
						accountId: r.accountId,
						amount: leg.amount,
						transactionId: txnRecord.id,
						reference: txnRecord.reference,
					}),
				]),
			);
		}
	}

	await Promise.all(batchOps);
}

// =============================================================================
// ACCOUNT BALANCE VERSION HELPERS
// =============================================================================

/**
 * Read the latest account_balance_version for an account.
 * Caller must hold FOR UPDATE lock on account_balance.id.
 */
export async function readLatestVersion(
	tx: { raw: <T>(sql: string, params: unknown[]) => Promise<T[]> },
	t: (name: string) => string,
	accountId: string,
): Promise<LatestVersion> {
	const rows = await tx.raw<LatestVersion>(
		`SELECT version, balance, credit_balance, debit_balance,
            pending_debit, pending_credit, status, checksum,
            freeze_reason, frozen_at, frozen_by,
            closed_at, closed_by, closure_reason
     FROM ${t("account_balance_version")}
     WHERE account_id = $1
     ORDER BY version DESC
     LIMIT 1`,
		[accountId],
	);
	const row = rows[0];
	if (!row) throw SummaError.internal(`No version found for account ${accountId}`);
	return row;
}
