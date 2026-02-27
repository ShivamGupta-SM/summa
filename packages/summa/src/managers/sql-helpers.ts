// =============================================================================
// SQL HELPERS — Shared SQL patterns for manager operations
// =============================================================================

import type {
	JournalEntryLeg,
	LedgerTransaction,
	SummaContext,
	SummaTransactionAdapter,
	TransactionStatus,
	TransactionType,
} from "@summa-ledger/core";
import { minorToDecimal, SummaError } from "@summa-ledger/core";
import { createTableResolver } from "@summa-ledger/core/db";
import { insertEntryAndUpdateBalance } from "./entry-balance.js";
import type { RawTransferRow } from "./raw-types.js";
import { getSystemAccount } from "./system-accounts.js";

// =============================================================================
// TRANSFER SQL
// =============================================================================

/** Build SQL to select from the `transfer` table. Status is a direct column now. */
export function transferSelectSql(t: (name: string) => string): string {
	return `SELECT * FROM ${t("transfer")}`;
}

// =============================================================================
// RAW ROW → RESPONSE MAPPING
// =============================================================================

/** Convert a raw transfer row to the public LedgerTransaction shape. */
export function rawToTransactionResponse(
	row: RawTransferRow,
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
		correlationId: row.correlation_id ?? "",
		isReversal: row.is_reversal,
		parentId: row.parent_id,
		metadata: (() => {
			const raw = (row.metadata ?? {}) as Record<string, unknown>;
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
		effectiveDate: row.effective_date
			? row.effective_date instanceof Date
				? row.effective_date.toISOString()
				: String(row.effective_date)
			: null,
	};
}

// =============================================================================
// JOURNAL LEGS PROCESSING
// =============================================================================

interface ResolvedLeg {
	leg: JournalEntryLeg;
	accountId: string | null;
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
	txnRecord: RawTransferRow,
	legs: JournalEntryLeg[],
	currency: string,
	_category: string,
	ledgerId: string,
): Promise<void> {
	const t = createTableResolver(ctx.options.schema);

	const resolved: ResolvedLeg[] = [];

	// Batch resolve system accounts
	const systemAccountNames = [
		...new Set(legs.map((l) => l.systemAccount).filter((n): n is string => !!n)),
	];
	const systemAccountMap = new Map<string, { id: string }>();
	for (const name of systemAccountNames) {
		const sys = await getSystemAccount(ctx, name, ledgerId);
		if (!sys) throw SummaError.notFound(`System account "${name}" not found`);
		systemAccountMap.set(name, sys);
	}

	for (const leg of legs) {
		if (leg.systemAccount) {
			const sys = systemAccountMap.get(leg.systemAccount);
			if (!sys) throw SummaError.notFound(`System account "${leg.systemAccount}" not found`);
			resolved.push({ leg, accountId: sys.id, isSystemAccount: true });
		} else if (leg.holderId) {
			resolved.push({ leg, accountId: null, isSystemAccount: false });
		}
	}

	// Resolve and lock user accounts in deterministic order to prevent deadlocks
	const holderIds = [
		...new Set(resolved.filter((r) => !r.isSystemAccount).map((r) => r.leg.holderId as string)),
	];
	holderIds.sort();

	const holderToAccount = new Map<string, { id: string; status: string }>();
	for (const holderId of holderIds) {
		// Lock account row and read status directly
		const rows = await tx.raw<{ id: string; status: string }>(
			`SELECT id, status FROM ${t("account")} WHERE ledger_id = $1 AND holder_id = $2 LIMIT 1 ${ctx.dialect.forUpdate()}`,
			[ledgerId, holderId],
		);
		const row = rows[0];
		if (!row) throw SummaError.notFound(`Account for holder "${holderId}" not found`);
		if (row.status !== "active") {
			throw SummaError.conflict(`Account for holder "${holderId}" is ${row.status}`);
		}
		holderToAccount.set(holderId, row);
	}

	// Fill in resolved account IDs
	for (const r of resolved) {
		if (!r.isSystemAccount && r.leg.holderId) {
			const acct = holderToAccount.get(r.leg.holderId);
			if (acct) r.accountId = acct.id;
		}
	}

	// Process each leg
	const batchOps: Promise<unknown>[] = [];

	for (const r of resolved) {
		const { leg } = r;
		const entryType = leg.direction === "debit" ? ("DEBIT" as const) : ("CREDIT" as const);

		if (r.accountId) {
			if (r.isSystemAccount) {
				// System account — hot path (skip balance update, batch later)
				await insertEntryAndUpdateBalance({
					tx,
					transferId: txnRecord.id,
					accountId: r.accountId,
					entryType,
					amount: leg.amount,
					currency,
					isHotAccount: true,
				});
			} else {
				// User account — full balance update
				await insertEntryAndUpdateBalance({
					tx,
					transferId: txnRecord.id,
					accountId: r.accountId,
					entryType,
					amount: leg.amount,
					currency,
					isHotAccount: false,
				});

				const topic =
					entryType === "DEBIT" ? "ledger-account-debited" : "ledger-account-credited";
				batchOps.push(
					tx.raw(`INSERT INTO ${t("outbox")} (topic, payload) VALUES ($1, $2)`, [
						topic,
						JSON.stringify({
							accountId: r.accountId,
							amount: leg.amount,
							transferId: txnRecord.id,
							reference: txnRecord.reference,
						}),
					]),
				);
			}
		}
	}

	await Promise.all(batchOps);
}

// =============================================================================
// ACCOUNT READ HELPERS
// =============================================================================

/**
 * Read the current balance state directly from the `account` table.
 * In the v2 schema, balance is a mutable column on account (no LATERAL JOIN).
 */
export async function readAccountBalance(
	tx: { raw: <T>(sql: string, params: unknown[]) => Promise<T[]> },
	t: (name: string) => string,
	accountId: string,
): Promise<{
	version: number;
	balance: number;
	credit_balance: number;
	debit_balance: number;
	pending_debit: number;
	pending_credit: number;
	status: string;
	checksum: string | null;
	freeze_reason: string | null;
	frozen_at: string | Date | null;
	frozen_by: string | null;
	closed_at: string | Date | null;
	closed_by: string | null;
	closure_reason: string | null;
}> {
	const rows = await tx.raw<{
		version: number;
		balance: number;
		credit_balance: number;
		debit_balance: number;
		pending_debit: number;
		pending_credit: number;
		status: string;
		checksum: string | null;
		freeze_reason: string | null;
		frozen_at: string | Date | null;
		frozen_by: string | null;
		closed_at: string | Date | null;
		closed_by: string | null;
		closure_reason: string | null;
	}>(
		`SELECT version, balance, credit_balance, debit_balance,
            pending_debit, pending_credit, status, checksum,
            freeze_reason, frozen_at, frozen_by,
            closed_at, closed_by, closure_reason
     FROM ${t("account")}
     WHERE id = $1`,
		[accountId],
	);
	const row = rows[0];
	if (!row) throw SummaError.internal(`Account ${accountId} not found`);
	return row;
}

/** @deprecated Use `readAccountBalance` instead. Kept for backward compat during migration. */
export const readLatestVersion = readAccountBalance;
