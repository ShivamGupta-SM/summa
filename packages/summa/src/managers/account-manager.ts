// =============================================================================
// ACCOUNT MANAGER -- Account lifecycle operations (APPEND-ONLY)
// =============================================================================
// Creates, reads, freezes, unfreezes, closes, and lists accounts.
// Uses ctx.adapter for all database operations.
//
// After the immutability refactor:
// - account_balance is IMMUTABLE (static properties only)
// - account_balance_version is APPEND-ONLY (each row = full state snapshot)
// - All state changes INSERT a new version row instead of UPDATE-ing

import { randomUUID } from "node:crypto";
import type {
	Account,
	AccountBalance as AccountBalanceType,
	AccountStatus,
	AccountType,
	HolderType,
	NormalBalance,
	SummaContext,
	SummaTransactionAdapter,
} from "@summa-ledger/core";
import {
	ACCOUNT_EVENTS,
	AGGREGATE_TYPES,
	computeBalanceChecksum,
	decodeCursor,
	encodeCursor,
	hashLockKey,
	SummaError,
	TRANSACTION_EVENTS,
} from "@summa-ledger/core";
import { createTableResolver } from "@summa-ledger/core/db";
import {
	runAfterAccountCreateHooks,
	runAfterOperationHooks,
	runBeforeAccountCreateHooks,
} from "../context/hooks.js";
import { appendEvent, withTransactionTimeout } from "../infrastructure/event-store.js";
import { insertEntryAndUpdateBalance } from "./entry-balance.js";
import { getLedgerId } from "./ledger-helpers.js";
import type { RawAccountRow } from "./raw-types.js";
import { readLatestVersion } from "./sql-helpers.js";

// =============================================================================
// SQL HELPERS
// =============================================================================

/** Build a SELECT that joins account_balance (static) with the latest account_balance_version. */
function accountSelectSql(t: (name: string) => string, denormalized = false): string {
	if (denormalized) {
		// Read balance state directly from cached columns on account_balance.
		// Avoids the LATERAL JOIN entirely — O(1) on the already-indexed parent row.
		return `SELECT a.*,
       a.cached_version AS version,
       a.cached_balance AS balance,
       a.cached_credit_balance AS credit_balance,
       a.cached_debit_balance AS debit_balance,
       a.cached_pending_credit AS pending_credit,
       a.cached_pending_debit AS pending_debit,
       a.cached_status AS status,
       a.cached_checksum AS checksum,
       a.cached_freeze_reason AS freeze_reason,
       a.cached_frozen_at AS frozen_at,
       a.cached_frozen_by AS frozen_by,
       a.cached_closed_at AS closed_at,
       a.cached_closed_by AS closed_by,
       a.cached_closure_reason AS closure_reason
FROM ${t("account_balance")} a`;
	}

	return `SELECT a.*, v.version, v.balance, v.credit_balance, v.debit_balance,
       v.pending_credit, v.pending_debit, v.status, v.checksum,
       v.freeze_reason, v.frozen_at, v.frozen_by,
       v.closed_at, v.closed_by, v.closure_reason
FROM ${t("account_balance")} a
JOIN LATERAL (
  SELECT * FROM ${t("account_balance_version")}
  WHERE account_id = a.id
  ORDER BY version DESC
  LIMIT 1
) v ON true`;
}

// =============================================================================
// CREATE ACCOUNT
// =============================================================================

const MAX_HOLDER_ID_LENGTH = 255;

export async function createAccount(
	ctx: SummaContext,
	params: {
		holderId: string;
		holderType: HolderType;
		currency?: string;
		allowOverdraft?: boolean;
		overdraftLimit?: number;
		indicator?: string;
		accountType?: AccountType;
		accountCode?: string;
		parentAccountId?: string;
		metadata?: Record<string, unknown>;
	},
): Promise<Account> {
	const {
		holderId,
		holderType,
		currency = ctx.options.currency,
		allowOverdraft = false,
		overdraftLimit = 0,
		indicator,
		accountType,
		accountCode,
		parentAccountId,
		metadata = {},
	} = params;

	// Derive normal balance from account type
	const normalBalance: NormalBalance | null = accountType ? deriveNormalBalance(accountType) : null;

	const VALID_HOLDER_TYPES: ReadonlySet<string> = new Set(["individual", "organization", "system"]);
	if (!VALID_HOLDER_TYPES.has(holderType)) {
		throw SummaError.invalidArgument(
			`Invalid holderType: "${holderType}". Must be one of: individual, organization, system`,
		);
	}

	if (!holderId || holderId.trim().length === 0) {
		throw SummaError.invalidArgument("holderId must not be empty");
	}

	if (holderId.length > MAX_HOLDER_ID_LENGTH) {
		throw SummaError.invalidArgument(
			`holderId exceeds maximum length of ${MAX_HOLDER_ID_LENGTH} characters`,
		);
	}

	const ledgerId = getLedgerId(ctx);

	const hookParams = { holderId, holderType, ctx };
	await runBeforeAccountCreateHooks(ctx, hookParams);

	const t = createTableResolver(ctx.options.schema);

	const dn = ctx.options.advanced.useDenormalizedBalance;

	// Fast path: check if account already exists (no lock needed)
	const existingRows = await ctx.adapter.raw<RawAccountRow>(
		`${accountSelectSql(t, dn)} WHERE a.ledger_id = $1 AND a.holder_id = $2 AND a.holder_type = $3 LIMIT 1`,
		[ledgerId, holderId, holderType],
	);

	if (existingRows[0]) {
		return rawRowToAccount(existingRows[0]);
	}

	// Slow path: acquire advisory lock to prevent race conditions.
	const lockKey = hashLockKey(`${ledgerId}:${holderId}:${holderType}`);

	const result = await withTransactionTimeout(ctx, async (tx) => {
		await tx.raw(ctx.dialect.advisoryLock(lockKey), []);

		// Re-check inside lock
		const existingInLockRows = await tx.raw<RawAccountRow>(
			`${accountSelectSql(t, dn)} WHERE a.ledger_id = $1 AND a.holder_id = $2 AND a.holder_type = $3 LIMIT 1`,
			[ledgerId, holderId, holderType],
		);

		if (existingInLockRows[0]) {
			return rawRowToAccount(existingInLockRows[0]);
		}

		// Validate parent account if specified
		if (parentAccountId) {
			const parentRows = await tx.raw<{ id: string; account_type: string | null }>(
				`SELECT id, account_type FROM ${t("account_balance")} WHERE ledger_id = $1 AND id = $2 LIMIT 1`,
				[ledgerId, parentAccountId],
			);
			const parent = parentRows[0];
			if (!parent) throw SummaError.notFound(`Parent account "${parentAccountId}" not found`);
			if (accountType && parent.account_type && parent.account_type !== accountType) {
				throw SummaError.invalidArgument(
					`Parent account type "${parent.account_type}" does not match child type "${accountType}"`,
				);
			}
		}

		// Step 1: INSERT into account_balance (IMMUTABLE — static properties only)
		// When denormalized balance is enabled, initialize cached columns too.
		const initialChecksum = computeBalanceChecksum(
			{
				balance: 0,
				creditBalance: 0,
				debitBalance: 0,
				pendingDebit: 0,
				pendingCredit: 0,
				lockVersion: 1,
			},
			ctx.options.advanced.hmacSecret,
		);

		const baseCols =
			"ledger_id, holder_id, holder_type, currency, allow_overdraft, overdraft_limit, indicator, account_type, account_code, parent_account_id, normal_balance, metadata";
		const baseVals = "$1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12";
		const baseParams: unknown[] = [
			ledgerId,
			holderId,
			holderType,
			currency,
			allowOverdraft,
			overdraftLimit,
			indicator ?? null,
			accountType ?? null,
			accountCode ?? null,
			parentAccountId ?? null,
			normalBalance,
			JSON.stringify(metadata),
		];

		let insertSql: string;
		let insertParams: unknown[];
		if (dn) {
			insertSql = `INSERT INTO ${t("account_balance")} (${baseCols}, cached_balance, cached_credit_balance, cached_debit_balance, cached_pending_debit, cached_pending_credit, cached_version, cached_status, cached_checksum)
       VALUES (${baseVals}, $13, $14, $15, $16, $17, $18, $19, $20)
       RETURNING id`;
			insertParams = [...baseParams, 0, 0, 0, 0, 0, 1, "active", initialChecksum];
		} else {
			insertSql = `INSERT INTO ${t("account_balance")} (${baseCols})
       VALUES (${baseVals})
       RETURNING id`;
			insertParams = baseParams;
		}

		const insertedRows = await tx.raw<{ id: string }>(insertSql, insertParams);

		const inserted = insertedRows[0];
		if (!inserted) throw SummaError.internal("Failed to insert account");
		const accountId = inserted.id;

		// Step 2: INSERT initial account_balance_version (version 1, active, zero balances)

		await tx.raw(
			`INSERT INTO ${t("account_balance_version")} (account_id, version, balance, credit_balance, debit_balance, pending_credit, pending_debit, status, checksum, change_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
			[accountId, 1, 0, 0, 0, 0, 0, "active", initialChecksum, "create"],
		);

		// Append event to event store
		const event = await appendEvent(
			tx,
			{
				aggregateType: AGGREGATE_TYPES.ACCOUNT,
				aggregateId: accountId,
				eventType: ACCOUNT_EVENTS.CREATED,
				eventData: {
					holderId,
					holderType,
					currency,
					allowOverdraft,
					indicator,
				},
			},
			ctx.options.schema,
			ctx.options.advanced.hmacSecret,
			ledgerId,
		);

		// Write to outbox for async publishing
		await tx.raw(
			`INSERT INTO ${t("outbox")} (event_id, topic, payload)
       VALUES ($1, $2, $3)`,
			[
				event.id,
				"ledger-account-created",
				JSON.stringify({
					accountId,
					holderId,
					holderType,
					currency,
					metadata,
				}),
			],
		);

		// Read back the combined row for response
		const createdRows = await tx.raw<RawAccountRow>(
			`${accountSelectSql(t, dn)} WHERE a.ledger_id = $1 AND a.id = $2`,
			[ledgerId, accountId],
		);
		const created = createdRows[0];
		if (!created) throw SummaError.internal("Failed to read created account");
		return rawRowToAccount(created);
	});

	await runAfterAccountCreateHooks(ctx, hookParams);
	await runAfterOperationHooks(ctx, {
		type: "account.create",
		params: { holderId, currency, holderType },
	});
	return result;
}

// =============================================================================
// GET ACCOUNT
// =============================================================================

export async function getAccountByHolder(ctx: SummaContext, holderId: string): Promise<Account> {
	const ledgerId = getLedgerId(ctx);
	const t = createTableResolver(ctx.options.schema);
	const dn = ctx.options.advanced.useDenormalizedBalance;
	const rows = await ctx.readAdapter.raw<RawAccountRow>(
		`${accountSelectSql(t, dn)} WHERE a.ledger_id = $1 AND a.holder_id = $2 LIMIT 1`,
		[ledgerId, holderId],
	);

	if (!rows[0]) throw SummaError.notFound("Account not found");
	return rawRowToAccount(rows[0]);
}

/** Resolve account by holderId inside a transaction with FOR UPDATE lock on immutable parent. */
export async function resolveAccountForUpdate(
	tx: SummaTransactionAdapter,
	ledgerId: string,
	holderId: string,
	schema: string,
	lockMode: "wait" | "nowait" | "optimistic" = "wait",
	useDenormalizedBalance = false,
): Promise<RawAccountRow> {
	const t = createTableResolver(schema);

	// Optimistic mode: read WITHOUT any lock. Rely on UNIQUE(account_id, version)
	// constraint on account_balance_version INSERT to detect conflicts.
	const isOptimistic = lockMode === "optimistic";
	const lockSuffix = isOptimistic ? "" : lockMode === "nowait" ? "FOR UPDATE NOWAIT" : "FOR UPDATE";

	if (useDenormalizedBalance) {
		// Denormalized path: lock + read cached balance in a single query.
		// No LATERAL JOIN needed — all state lives on account_balance.
		const rows = await tx.raw<RawAccountRow>(
			`${accountSelectSql(t, true)} WHERE a.ledger_id = $1 AND a.holder_id = $2 LIMIT 1 ${lockSuffix}`,
			[ledgerId, holderId],
		);
		if (!rows[0]) throw SummaError.notFound(`Account not found for holder ${holderId}`);
		const row = rows[0];

		if (row.checksum) {
			const hmacSecret = tx.options?.hmacSecret ?? null;
			const expected = computeBalanceChecksum(
				{
					balance: Number(row.balance),
					creditBalance: Number(row.credit_balance),
					debitBalance: Number(row.debit_balance),
					pendingDebit: Number(row.pending_debit),
					pendingCredit: Number(row.pending_credit),
					lockVersion: Number(row.version),
				},
				hmacSecret,
			);
			if (expected !== row.checksum) {
				throw SummaError.chainIntegrityViolation(
					`Balance checksum mismatch for account ${row.id}: balance data may have been tampered with`,
				);
			}
		}

		return row;
	}

	if (isOptimistic) {
		// Optimistic path: read without locking. Conflict detected at INSERT time.
		const rows = await tx.raw<RawAccountRow>(
			`${accountSelectSql(t)} WHERE a.ledger_id = $1 AND a.holder_id = $2`,
			[ledgerId, holderId],
		);
		if (!rows[0]) throw SummaError.notFound(`Account not found for holder ${holderId}`);
		const row = rows[0];

		if (row.checksum) {
			const hmacSecret = tx.options?.hmacSecret ?? null;
			const expected = computeBalanceChecksum(
				{
					balance: Number(row.balance),
					creditBalance: Number(row.credit_balance),
					debitBalance: Number(row.debit_balance),
					pendingDebit: Number(row.pending_debit),
					pendingCredit: Number(row.pending_credit),
					lockVersion: Number(row.version),
				},
				hmacSecret,
			);
			if (expected !== row.checksum) {
				throw SummaError.chainIntegrityViolation(
					`Balance checksum mismatch for account ${row.id}: balance data may have been tampered with`,
				);
			}
		}

		return row;
	}

	// Standard path: lock parent row, then LATERAL JOIN for latest version.
	const parentRows = await tx.raw<{ id: string }>(
		`SELECT id FROM ${t("account_balance")}
     WHERE ledger_id = $1 AND holder_id = $2
     LIMIT 1
     ${lockSuffix}`,
		[ledgerId, holderId],
	);
	if (!parentRows[0]) throw SummaError.notFound(`Account not found for holder ${holderId}`);
	const accountId = parentRows[0].id;

	const rows = await tx.raw<RawAccountRow>(
		`${accountSelectSql(t)} WHERE a.ledger_id = $1 AND a.id = $2`,
		[ledgerId, accountId],
	);
	if (!rows[0]) throw SummaError.notFound(`Account not found for holder ${holderId}`);

	const row = rows[0];

	if (row.checksum) {
		const hmacSecret = tx.options?.hmacSecret ?? null;
		const expected = computeBalanceChecksum(
			{
				balance: Number(row.balance),
				creditBalance: Number(row.credit_balance),
				debitBalance: Number(row.debit_balance),
				pendingDebit: Number(row.pending_debit),
				pendingCredit: Number(row.pending_credit),
				lockVersion: Number(row.version),
			},
			hmacSecret,
		);
		if (expected !== row.checksum) {
			throw SummaError.chainIntegrityViolation(
				`Balance checksum mismatch for account ${row.id}: balance data may have been tampered with`,
			);
		}
	}

	return row;
}

export async function getAccountById(ctx: SummaContext, accountId: string): Promise<Account> {
	const ledgerId = getLedgerId(ctx);
	const t = createTableResolver(ctx.options.schema);
	const dn = ctx.options.advanced.useDenormalizedBalance;
	const rows = await ctx.readAdapter.raw<RawAccountRow>(
		`${accountSelectSql(t, dn)} WHERE a.ledger_id = $1 AND a.id = $2 LIMIT 1`,
		[ledgerId, accountId],
	);

	if (!rows[0]) throw SummaError.notFound("Account not found");
	return rawRowToAccount(rows[0]);
}

// =============================================================================
// GET BALANCE
// =============================================================================

export async function getAccountBalance(
	ctx: SummaContext,
	account: Account,
	options?: { asOf?: Date | string },
): Promise<AccountBalanceType> {
	// Point-in-time balance query via effective_date
	if (options?.asOf) {
		const { getBalanceAsOf } = await import("./effective-date.js");
		const result = await getBalanceAsOf(ctx, account.id, options.asOf);
		return {
			balance: result.balance,
			creditBalance: result.creditBalance,
			debitBalance: result.debitBalance,
			pendingCredit: 0,
			pendingDebit: 0,
			availableBalance: result.balance,
			currency: result.currency,
		};
	}

	const ledgerId = getLedgerId(ctx);
	const t = createTableResolver(ctx.options.schema);
	const dn = ctx.options.advanced.useDenormalizedBalance;
	const rows = await ctx.adapter.raw<RawAccountRow>(
		`${accountSelectSql(t, dn)} WHERE a.ledger_id = $1 AND a.id = $2 LIMIT 1`,
		[ledgerId, account.id],
	);

	if (!rows[0]) throw SummaError.notFound("Account not found");

	const row = rows[0];

	// Verify balance checksum if present (tamper detection)
	if (row.checksum) {
		const expected = computeBalanceChecksum(
			{
				balance: Number(row.balance),
				creditBalance: Number(row.credit_balance),
				debitBalance: Number(row.debit_balance),
				pendingDebit: Number(row.pending_debit),
				pendingCredit: Number(row.pending_credit),
				lockVersion: Number(row.version),
			},
			ctx.options.advanced.hmacSecret,
		);
		if (expected !== row.checksum) {
			throw SummaError.chainIntegrityViolation(
				`Balance checksum mismatch for account ${row.id}: balance data may have been tampered with`,
			);
		}
	}

	const available = Math.max(0, Number(row.balance) - Number(row.pending_debit));

	return {
		balance: Number(row.balance),
		creditBalance: Number(row.credit_balance),
		debitBalance: Number(row.debit_balance),
		pendingCredit: Number(row.pending_credit),
		pendingDebit: Number(row.pending_debit),
		availableBalance: available,
		currency: row.currency,
	};
}

// =============================================================================
// FREEZE / UNFREEZE
// =============================================================================

export async function freezeAccount(
	ctx: SummaContext,
	params: {
		holderId: string;
		reason: string;
		frozenBy: string;
	},
): Promise<Account> {
	const { holderId, reason, frozenBy } = params;
	const ledgerId = getLedgerId(ctx);
	const t = createTableResolver(ctx.options.schema);

	const dn = ctx.options.advanced.useDenormalizedBalance;

	const result = await withTransactionTimeout(ctx, async (tx) => {
		// Lock and read inside transaction to prevent TOCTOU race
		const lockedRow = await resolveAccountForUpdate(
			tx,
			ledgerId,
			holderId,
			ctx.options.schema,
			ctx.options.advanced.lockMode,
			dn,
		);

		if (lockedRow.status === "frozen") {
			// Idempotent retry -- account already frozen
			return rawRowToAccount(lockedRow);
		}
		if (lockedRow.status === "closed") {
			throw SummaError.accountClosed("Account is closed");
		}

		// INSERT new version row with frozen status (APPEND-ONLY — no UPDATE)
		const newVersion = Number(lockedRow.version) + 1;
		const checksum = computeBalanceChecksum(
			{
				balance: Number(lockedRow.balance),
				creditBalance: Number(lockedRow.credit_balance),
				debitBalance: Number(lockedRow.debit_balance),
				pendingDebit: Number(lockedRow.pending_debit),
				pendingCredit: Number(lockedRow.pending_credit),
				lockVersion: newVersion,
			},
			ctx.options.advanced.hmacSecret,
		);

		await tx.raw(
			`INSERT INTO ${t("account_balance_version")} (
         account_id, version, balance, credit_balance, debit_balance,
         pending_credit, pending_debit, status, checksum,
         freeze_reason, frozen_at, frozen_by,
         closed_at, closed_by, closure_reason,
         change_type
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), $11, $12, $13, $14, $15)`,
			[
				lockedRow.id,
				newVersion,
				Number(lockedRow.balance),
				Number(lockedRow.credit_balance),
				Number(lockedRow.debit_balance),
				Number(lockedRow.pending_credit),
				Number(lockedRow.pending_debit),
				"frozen",
				checksum,
				reason,
				frozenBy,
				lockedRow.closed_at ?? null,
				lockedRow.closed_by ?? null,
				lockedRow.closure_reason ?? null,
				"freeze",
			],
		);

		if (dn) {
			await updateDenormalizedCache(tx, t, lockedRow.id, {
				balance: Number(lockedRow.balance),
				creditBalance: Number(lockedRow.credit_balance),
				debitBalance: Number(lockedRow.debit_balance),
				pendingDebit: Number(lockedRow.pending_debit),
				pendingCredit: Number(lockedRow.pending_credit),
				version: newVersion,
				status: "frozen",
				checksum,
				freezeReason: reason,
				frozenAt: new Date().toISOString(),
				frozenBy,
				closedAt: lockedRow.closed_at ?? null,
				closedBy: lockedRow.closed_by ?? null,
				closureReason: lockedRow.closure_reason ?? null,
			});
		}

		await appendEvent(
			tx,
			{
				aggregateType: AGGREGATE_TYPES.ACCOUNT,
				aggregateId: lockedRow.id,
				eventType: ACCOUNT_EVENTS.FROZEN,
				eventData: { reason, frozenBy },
			},
			ctx.options.schema,
			ctx.options.advanced.hmacSecret,
			ledgerId,
		);

		await tx.raw(
			`INSERT INTO ${t("outbox")} (topic, payload)
       VALUES ($1, $2)`,
			[
				"ledger-account-frozen",
				JSON.stringify({
					accountId: lockedRow.id,
					holderId,
					holderType: lockedRow.holder_type,
					reason,
					frozenBy,
				}),
			],
		);

		// Read back to return
		const updatedRows = await tx.raw<RawAccountRow>(
			`${accountSelectSql(t, dn)} WHERE a.ledger_id = $1 AND a.id = $2`,
			[ledgerId, lockedRow.id],
		);
		const frozen = updatedRows[0];
		if (!frozen) throw SummaError.internal("Failed to read frozen account");
		return rawRowToAccount(frozen);
	});

	await runAfterOperationHooks(ctx, {
		type: "account.freeze",
		params: { holderId, reason, frozenBy },
	});
	return result;
}

export async function unfreezeAccount(
	ctx: SummaContext,
	params: {
		holderId: string;
		unfrozenBy: string;
		reason?: string;
	},
): Promise<Account> {
	const { holderId, unfrozenBy } = params;
	const ledgerId = getLedgerId(ctx);
	const t = createTableResolver(ctx.options.schema);
	const dn = ctx.options.advanced.useDenormalizedBalance;

	const result = await withTransactionTimeout(ctx, async (tx) => {
		const lockedRow = await resolveAccountForUpdate(
			tx,
			ledgerId,
			holderId,
			ctx.options.schema,
			ctx.options.advanced.lockMode,
			dn,
		);

		if (lockedRow.status === "active") {
			// Idempotent retry -- account already active
			return rawRowToAccount(lockedRow);
		}
		if (lockedRow.status !== "frozen") {
			throw SummaError.conflict(`Cannot unfreeze account in status: ${lockedRow.status}`);
		}

		// INSERT new version row with active status (APPEND-ONLY — no UPDATE)
		const newVersion = Number(lockedRow.version) + 1;
		const checksum = computeBalanceChecksum(
			{
				balance: Number(lockedRow.balance),
				creditBalance: Number(lockedRow.credit_balance),
				debitBalance: Number(lockedRow.debit_balance),
				pendingDebit: Number(lockedRow.pending_debit),
				pendingCredit: Number(lockedRow.pending_credit),
				lockVersion: newVersion,
			},
			ctx.options.advanced.hmacSecret,
		);

		await tx.raw(
			`INSERT INTO ${t("account_balance_version")} (
         account_id, version, balance, credit_balance, debit_balance,
         pending_credit, pending_debit, status, checksum,
         freeze_reason, frozen_at, frozen_by,
         closed_at, closed_by, closure_reason,
         change_type
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
			[
				lockedRow.id,
				newVersion,
				Number(lockedRow.balance),
				Number(lockedRow.credit_balance),
				Number(lockedRow.debit_balance),
				Number(lockedRow.pending_credit),
				Number(lockedRow.pending_debit),
				"active",
				checksum,
				null,
				null,
				null, // Clear freeze fields
				lockedRow.closed_at ?? null,
				lockedRow.closed_by ?? null,
				lockedRow.closure_reason ?? null,
				"unfreeze",
			],
		);

		if (dn) {
			await updateDenormalizedCache(tx, t, lockedRow.id, {
				balance: Number(lockedRow.balance),
				creditBalance: Number(lockedRow.credit_balance),
				debitBalance: Number(lockedRow.debit_balance),
				pendingDebit: Number(lockedRow.pending_debit),
				pendingCredit: Number(lockedRow.pending_credit),
				version: newVersion,
				status: "active",
				checksum,
				freezeReason: null,
				frozenAt: null,
				frozenBy: null,
				closedAt: lockedRow.closed_at ?? null,
				closedBy: lockedRow.closed_by ?? null,
				closureReason: lockedRow.closure_reason ?? null,
			});
		}

		await appendEvent(
			tx,
			{
				aggregateType: AGGREGATE_TYPES.ACCOUNT,
				aggregateId: lockedRow.id,
				eventType: ACCOUNT_EVENTS.UNFROZEN,
				eventData: { unfrozenBy },
			},
			ctx.options.schema,
			ctx.options.advanced.hmacSecret,
			ledgerId,
		);

		await tx.raw(
			`INSERT INTO ${t("outbox")} (topic, payload)
       VALUES ($1, $2)`,
			[
				"ledger-account-unfrozen",
				JSON.stringify({
					accountId: lockedRow.id,
					holderId,
					holderType: lockedRow.holder_type,
					unfrozenBy,
				}),
			],
		);

		// Read back to return
		const updatedRows = await tx.raw<RawAccountRow>(
			`${accountSelectSql(t, dn)} WHERE a.ledger_id = $1 AND a.id = $2`,
			[ledgerId, lockedRow.id],
		);
		const unfrozen = updatedRows[0];
		if (!unfrozen) throw SummaError.internal("Failed to read unfrozen account");
		return rawRowToAccount(unfrozen);
	});

	await runAfterOperationHooks(ctx, { type: "account.unfreeze", params: { holderId, unfrozenBy } });
	return result;
}

// =============================================================================
// CLOSE ACCOUNT
// =============================================================================

export async function closeAccount(
	ctx: SummaContext,
	params: {
		holderId: string;
		closedBy: string;
		reason?: string;
		transferToHolderId?: string;
	},
): Promise<Account> {
	const { holderId, closedBy, reason } = params;
	const ledgerId = getLedgerId(ctx);
	const t = createTableResolver(ctx.options.schema);
	const dn = ctx.options.advanced.useDenormalizedBalance;

	const result = await withTransactionTimeout(ctx, async (tx) => {
		let sweepTxnId: string | null = null;

		// If sweep is needed, resolve destination first (without lock) to get its ID
		let destAccountId: string | null = null;
		if (params.transferToHolderId) {
			const destRows = await tx.raw<{ id: string }>(
				`SELECT id FROM ${t("account_balance")}
         WHERE ledger_id = $1 AND holder_id = $2
         LIMIT 1`,
				[ledgerId, params.transferToHolderId],
			);
			if (destRows[0]) destAccountId = destRows[0].id;
		}

		// Lock the source account inside the transaction (prevents TOCTOU race)
		const sourceRow = await resolveAccountForUpdate(
			tx,
			ledgerId,
			holderId,
			ctx.options.schema,
			ctx.options.advanced.lockMode,
			dn,
		);

		// Status checks INSIDE transaction after acquiring lock
		if (sourceRow.status === "closed") {
			return rawRowToAccount(sourceRow);
		}
		if (sourceRow.status === "frozen") {
			throw SummaError.accountFrozen("Cannot close a frozen account. Unfreeze first.");
		}

		// Check for active holds using LATERAL JOIN to get latest transaction_status
		const activeHoldRows = await tx.raw<{ count: number }>(
			`SELECT ${ctx.dialect.countAsInt()} AS count FROM ${t("transaction_record")} tr
       JOIN LATERAL (
         SELECT status FROM ${t("transaction_status")}
         WHERE transaction_id = tr.id
         ORDER BY created_at DESC
         LIMIT 1
       ) ts ON true
       WHERE tr.source_account_id = $1
         AND tr.is_hold = true
         AND ts.status = 'inflight'`,
			[sourceRow.id],
		);

		if (activeHoldRows[0] && activeHoldRows[0].count > 0) {
			throw SummaError.conflict(
				`Cannot close account with ${activeHoldRows[0].count} active hold(s). Void or commit them first.`,
			);
		}

		// Lock destination if needed
		let destRow: { id: string; status: string; currency: string } | null = null;
		if (destAccountId && destAccountId !== sourceRow.id) {
			if (dn) {
				// Denormalized: lock + read status from cached columns in one query
				const destRows = await tx.raw<{ id: string; cached_status: string; currency: string }>(
					`SELECT id, cached_status, currency FROM ${t("account_balance")} WHERE ledger_id = $1 AND id = $2 FOR UPDATE`,
					[ledgerId, destAccountId],
				);
				if (destRows[0]) {
					destRow = {
						id: destAccountId,
						status: destRows[0].cached_status,
						currency: destRows[0].currency,
					};
				}
			} else {
				// Standard: lock parent, then LATERAL JOIN for latest version
				await tx.raw(
					`SELECT id FROM ${t("account_balance")} WHERE ledger_id = $1 AND id = $2 FOR UPDATE`,
					[ledgerId, destAccountId],
				);
				const destVersionRows = await tx.raw<{ status: string; currency: string }>(
					`SELECT v.status, a.currency
           FROM ${t("account_balance")} a
           JOIN LATERAL (
             SELECT status FROM ${t("account_balance_version")}
             WHERE account_id = a.id ORDER BY version DESC LIMIT 1
           ) v ON true
           WHERE a.ledger_id = $1 AND a.id = $2`,
					[ledgerId, destAccountId],
				);
				if (destVersionRows[0]) {
					destRow = {
						id: destAccountId,
						status: destVersionRows[0].status,
						currency: destVersionRows[0].currency,
					};
				}
			}
		}

		const sweepAmount = Number(sourceRow.balance);

		// If there's a balance, require a sweep destination
		if (sweepAmount > 0 && !params.transferToHolderId) {
			throw SummaError.invalidArgument(
				`Cannot close account with balance of ${sweepAmount}. Provide transferToHolderId to sweep funds.`,
			);
		}

		// Sweep funds if balance > 0
		if (sweepAmount > 0 && params.transferToHolderId) {
			const correlationId = randomUUID();

			if (!destRow) throw SummaError.notFound("Destination account not found");
			if (destRow.status !== "active") {
				throw SummaError.conflict("Destination account is not active");
			}
			if (destRow.currency !== sourceRow.currency) {
				throw SummaError.invalidArgument(
					`Currency mismatch: source is ${sourceRow.currency}, destination is ${destRow.currency}`,
				);
			}

			// Create sweep transaction record (IMMUTABLE — no status field)
			const sweepTxnRows = await tx.raw<{ id: string; reference: string }>(
				`INSERT INTO ${t("transaction_record")} (type, reference, amount, currency, description, source_account_id, destination_account_id, correlation_id, meta_data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, reference`,
				[
					"transfer",
					`sweep_close_${sourceRow.id}`,
					sweepAmount,
					sourceRow.currency,
					`Account closure sweep to ${params.transferToHolderId}`,
					sourceRow.id,
					destRow.id,
					correlationId,
					JSON.stringify({ type: "closure_sweep", closedBy, reason }),
				],
			);

			sweepTxnId = sweepTxnRows[0]?.id ?? "";

			// INSERT initial transaction_status for sweep (APPEND-ONLY)
			await tx.raw(
				`INSERT INTO ${t("transaction_status")} (transaction_id, status, posted_at)
         VALUES ($1, $2, NOW())`,
				[sweepTxnId, "posted"],
			);

			// Debit source + update balance
			await insertEntryAndUpdateBalance({
				tx,
				transactionId: sweepTxnId,
				accountId: sourceRow.id,
				entryType: "DEBIT",
				amount: sweepAmount,
				currency: sourceRow.currency,
				isHotAccount: false,
				skipLock: true,
				updateDenormalizedCache: dn,
			});

			// Credit destination + update balance
			await insertEntryAndUpdateBalance({
				tx,
				transactionId: sweepTxnId,
				accountId: destRow.id,
				entryType: "CREDIT",
				amount: sweepAmount,
				currency: sourceRow.currency,
				isHotAccount: false,
				updateDenormalizedCache: dn,
			});

			// Event for sweep
			if (!sweepTxnId) throw SummaError.internal("Sweep transaction ID missing after insert");
			await appendEvent(
				tx,
				{
					aggregateType: AGGREGATE_TYPES.TRANSACTION,
					aggregateId: sweepTxnId,
					eventType: TRANSACTION_EVENTS.POSTED,
					eventData: {
						reference: `sweep_close_${sourceRow.id}`,
						amount: sweepAmount,
						source: holderId,
						destination: params.transferToHolderId,
						category: "closure_sweep",
					},
					correlationId,
				},
				ctx.options.schema,
				ctx.options.advanced.hmacSecret,
				ledgerId,
			);
		}

		// Close the account by inserting a new version with closed status
		// Re-read the latest version since sweep may have changed the balance
		const latest = await readLatestVersion(tx, t, sourceRow.id);
		const closeVersion = Number(latest.version) + 1;
		const closeChecksum = computeBalanceChecksum(
			{
				balance: Number(latest.balance),
				creditBalance: Number(latest.credit_balance),
				debitBalance: Number(latest.debit_balance),
				pendingDebit: Number(latest.pending_debit),
				pendingCredit: Number(latest.pending_credit),
				lockVersion: closeVersion,
			},
			ctx.options.advanced.hmacSecret,
		);

		await tx.raw(
			`INSERT INTO ${t("account_balance_version")} (
         account_id, version, balance, credit_balance, debit_balance,
         pending_credit, pending_debit, status, checksum,
         freeze_reason, frozen_at, frozen_by,
         closed_at, closed_by, closure_reason,
         change_type
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), $13, $14, $15)`,
			[
				sourceRow.id,
				closeVersion,
				Number(latest.balance),
				Number(latest.credit_balance),
				Number(latest.debit_balance),
				Number(latest.pending_credit),
				Number(latest.pending_debit),
				"closed",
				closeChecksum,
				latest.freeze_reason ?? null,
				latest.frozen_at ?? null,
				latest.frozen_by ?? null,
				closedBy,
				reason ?? null,
				"close",
			],
		);

		if (dn) {
			await updateDenormalizedCache(tx, t, sourceRow.id, {
				balance: Number(latest.balance),
				creditBalance: Number(latest.credit_balance),
				debitBalance: Number(latest.debit_balance),
				pendingDebit: Number(latest.pending_debit),
				pendingCredit: Number(latest.pending_credit),
				version: closeVersion,
				status: "closed",
				checksum: closeChecksum,
				freezeReason: latest.freeze_reason ?? null,
				frozenAt: latest.frozen_at ?? null,
				frozenBy: latest.frozen_by ?? null,
				closedAt: new Date().toISOString(),
				closedBy,
				closureReason: reason ?? null,
			});
		}

		await appendEvent(
			tx,
			{
				aggregateType: AGGREGATE_TYPES.ACCOUNT,
				aggregateId: sourceRow.id,
				eventType: ACCOUNT_EVENTS.CLOSED,
				eventData: {
					closedBy,
					reason,
					finalBalance: sweepAmount,
					sweepTransactionId: sweepTxnId,
				},
			},
			ctx.options.schema,
			ctx.options.advanced.hmacSecret,
			ledgerId,
		);

		await tx.raw(
			`INSERT INTO ${t("outbox")} (topic, payload)
       VALUES ($1, $2)`,
			[
				"ledger-account-closed",
				JSON.stringify({
					accountId: sourceRow.id,
					holderId,
					holderType: sourceRow.holder_type,
					closedBy,
					reason,
					finalBalance: sweepAmount,
					sweepTransactionId: sweepTxnId,
				}),
			],
		);

		ctx.logger.info("Account closed", {
			accountId: sourceRow.id,
			holderId,
			closedBy,
			sweepAmount: sweepAmount > 0 ? sweepAmount : undefined,
		});

		// Read back final state
		const closedRows = await tx.raw<RawAccountRow>(
			`${accountSelectSql(t, dn)} WHERE a.ledger_id = $1 AND a.id = $2`,
			[ledgerId, sourceRow.id],
		);
		const closed = closedRows[0];
		if (!closed) throw SummaError.internal("Failed to read closed account");
		return rawRowToAccount(closed);
	});

	await runAfterOperationHooks(ctx, {
		type: "account.close",
		params: { holderId, closedBy, reason },
	});
	return result;
}

// =============================================================================
// LIST ACCOUNTS (Admin)
// =============================================================================

export async function listAccounts(
	ctx: SummaContext,
	params: {
		page?: number;
		perPage?: number;
		status?: AccountStatus;
		holderType?: HolderType;
		search?: string;
		/** Opaque cursor for keyset pagination (faster than page/perPage at depth). */
		cursor?: string;
		/** Items per page when using cursor pagination. Default: 20, max: 100. */
		limit?: number;
	},
): Promise<{ accounts: Account[]; hasMore: boolean; total: number; nextCursor?: string }> {
	const VALID_STATUSES: ReadonlySet<string> = new Set(["active", "frozen", "closed"]);
	const VALID_HOLDER_TYPES: ReadonlySet<string> = new Set(["individual", "organization", "system"]);

	if (params.status && !VALID_STATUSES.has(params.status)) {
		throw SummaError.invalidArgument(
			`Invalid status: "${params.status}". Must be one of: active, frozen, closed`,
		);
	}
	if (params.holderType && !VALID_HOLDER_TYPES.has(params.holderType)) {
		throw SummaError.invalidArgument(
			`Invalid holderType: "${params.holderType}". Must be one of: individual, organization, system`,
		);
	}

	const ledgerId = getLedgerId(ctx);
	const t = createTableResolver(ctx.options.schema);
	const dn = ctx.options.advanced.useDenormalizedBalance;

	// Build dynamic WHERE conditions.
	// Conditions reference output column names of the subquery (via "combined" alias).
	const conditions: string[] = [];
	const queryParams: unknown[] = [];
	let paramIdx = 1;

	// Mandatory ledger_id filter
	conditions.push(`combined.ledger_id = $${paramIdx++}`);
	queryParams.push(ledgerId);

	if (params.status) {
		conditions.push(`combined.status = $${paramIdx++}`);
		queryParams.push(params.status);
	}
	if (params.holderType) {
		conditions.push(`combined.holder_type = $${paramIdx++}`);
		queryParams.push(params.holderType);
	}
	if (params.search) {
		conditions.push(`combined.holder_id = $${paramIdx++}`);
		queryParams.push(params.search);
	}

	// Cursor-based pagination: use keyset filtering instead of OFFSET
	const useCursor = params.cursor != null;
	const cursorData = useCursor && params.cursor ? decodeCursor(params.cursor) : null;
	if (useCursor && !cursorData) {
		throw SummaError.invalidArgument("Invalid cursor");
	}

	if (cursorData) {
		conditions.push(
			`(combined.created_at, combined.id) > ($${paramIdx}::timestamptz, $${paramIdx + 1})`,
		);
		queryParams.push(cursorData.ca, cursorData.id);
		paramIdx += 2;
	}

	const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

	const perPage = Math.min(params.limit ?? params.perPage ?? 20, 100);

	if (useCursor) {
		// Cursor-based: no OFFSET, no COUNT(*) OVER() (faster)
		queryParams.push(perPage + 1);
		const rows = await ctx.readAdapter.raw<RawAccountRow>(
			`SELECT combined.* FROM (
           ${accountSelectSql(t, dn)}
         ) combined
         ${whereClause}
         ORDER BY combined.created_at ASC, combined.id ASC
         LIMIT $${paramIdx}`,
			queryParams,
		);

		const hasMore = rows.length > perPage;
		const data = (hasMore ? rows.slice(0, perPage) : rows).map(rawRowToAccount);
		const lastRow = hasMore ? rows[perPage - 1] : undefined;
		const nextCursor = lastRow ? encodeCursor(lastRow.created_at, lastRow.id) : undefined;

		return { accounts: data, hasMore, total: -1, nextCursor };
	}

	// OFFSET/LIMIT pagination
	const page = Math.max(1, params.page ?? 1);
	const offset = (page - 1) * perPage;

	queryParams.push(perPage + 1);
	queryParams.push(offset);
	const rows = await ctx.readAdapter.raw<RawAccountRow & { _total_count: number }>(
		`SELECT combined.*, COUNT(*) OVER()::int AS _total_count FROM (
       ${accountSelectSql(t, dn)}
     ) combined
     ${whereClause}
     ORDER BY combined.created_at ASC
     LIMIT $${paramIdx++}
     OFFSET $${paramIdx}`,
		queryParams,
	);

	const total = rows[0]?._total_count ?? 0;
	const hasMore = rows.length > perPage;
	const data = (hasMore ? rows.slice(0, perPage) : rows).map(rawRowToAccount);
	const lastRow = hasMore ? rows[perPage - 1] : undefined;
	const nextCursor = lastRow ? encodeCursor(lastRow.created_at, lastRow.id) : undefined;

	return { accounts: data, hasMore, total, nextCursor };
}

// =============================================================================
// HELPERS
// =============================================================================

function rawRowToAccount(row: RawAccountRow): Account {
	return {
		id: row.id,
		holderId: row.holder_id,
		holderType: row.holder_type as HolderType,
		status: row.status as AccountStatus,
		currency: row.currency,
		balance: Number(row.balance),
		creditBalance: Number(row.credit_balance),
		debitBalance: Number(row.debit_balance),
		pendingCredit: Number(row.pending_credit),
		pendingDebit: Number(row.pending_debit),
		allowOverdraft: row.allow_overdraft,
		overdraftLimit: Number(row.overdraft_limit ?? 0),
		accountType: (row.account_type as Account["accountType"]) ?? null,
		accountCode: row.account_code ?? null,
		parentAccountId: row.parent_account_id ?? null,
		normalBalance: (row.normal_balance as Account["normalBalance"]) ?? null,
		indicator: row.indicator ?? null,
		freezeReason: row.freeze_reason ?? null,
		frozenAt: row.frozen_at ? new Date(row.frozen_at) : null,
		frozenBy: row.frozen_by ?? null,
		closedAt: row.closed_at ? new Date(row.closed_at) : null,
		closedBy: row.closed_by ?? null,
		closureReason: row.closure_reason ?? null,
		metadata: (row.metadata ?? {}) as Record<string, unknown>,
		createdAt: new Date(row.created_at),
		updatedAt: new Date(row.created_at),
	};
}

function deriveNormalBalance(accountType: AccountType): NormalBalance {
	return accountType === "asset" || accountType === "expense" ? "debit" : "credit";
}

/**
 * Update the denormalized cached_* columns on account_balance.
 * Called after inserting a new account_balance_version row in freeze/unfreeze/close paths.
 */
async function updateDenormalizedCache(
	tx: SummaTransactionAdapter,
	t: (name: string) => string,
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
		freezeReason: string | null;
		frozenAt: string | Date | null;
		frozenBy: string | null;
		closedAt: string | Date | null;
		closedBy: string | null;
		closureReason: string | null;
	},
): Promise<void> {
	await tx.raw(
		`UPDATE ${t("account_balance")} SET
		   cached_balance = $1,
		   cached_credit_balance = $2,
		   cached_debit_balance = $3,
		   cached_pending_debit = $4,
		   cached_pending_credit = $5,
		   cached_version = $6,
		   cached_status = $7,
		   cached_checksum = $8,
		   cached_freeze_reason = $9,
		   cached_frozen_at = $10,
		   cached_frozen_by = $11,
		   cached_closed_at = $12,
		   cached_closed_by = $13,
		   cached_closure_reason = $14
		 WHERE id = $15`,
		[
			data.balance,
			data.creditBalance,
			data.debitBalance,
			data.pendingDebit,
			data.pendingCredit,
			data.version,
			data.status,
			data.checksum,
			data.freezeReason,
			data.frozenAt,
			data.frozenBy,
			data.closedAt,
			data.closedBy,
			data.closureReason,
			accountId,
		],
	);
}
