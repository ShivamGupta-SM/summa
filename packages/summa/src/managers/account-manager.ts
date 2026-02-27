// =============================================================================
// ACCOUNT MANAGER -- Account lifecycle operations
// =============================================================================
// Creates, reads, freezes, unfreezes, closes, and lists accounts.
// Uses the unified `account` table with mutable balance + HMAC checksum.

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
	computeBalanceChecksum,
	decodeCursor,
	encodeCursor,
	hashLockKey,
	SummaError,
} from "@summa-ledger/core";
import { createTableResolver } from "@summa-ledger/core/db";
import {
	runAfterAccountCreateHooks,
	runAfterOperationHooks,
	runBeforeAccountCreateHooks,
} from "../context/hooks.js";
import { withTransactionTimeout } from "../infrastructure/event-store.js";
import { insertEntryAndUpdateBalance } from "./entry-balance.js";
import { getLedgerId } from "./ledger-helpers.js";
import type { RawAccountRow } from "./raw-types.js";

// =============================================================================
// SQL HELPERS
// =============================================================================

/** Build a SELECT for the unified account table. Direct read — no LATERAL JOIN needed. */
function accountSelectSql(t: (name: string) => string): string {
	return `SELECT * FROM ${t("account")}`;
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

	// Fast path: check if account already exists (no lock needed)
	const existingRows = await ctx.adapter.raw<RawAccountRow>(
		`${accountSelectSql(t)} WHERE ledger_id = $1 AND holder_id = $2 AND holder_type = $3 AND is_system = false LIMIT 1`,
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
			`${accountSelectSql(t)} WHERE ledger_id = $1 AND holder_id = $2 AND holder_type = $3 AND is_system = false LIMIT 1`,
			[ledgerId, holderId, holderType],
		);

		if (existingInLockRows[0]) {
			return rawRowToAccount(existingInLockRows[0]);
		}

		// Validate parent account if specified
		if (parentAccountId) {
			const parentRows = await tx.raw<{ id: string; account_type: string | null }>(
				`SELECT id, account_type FROM ${t("account")} WHERE ledger_id = $1 AND id = $2 LIMIT 1`,
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

		// Compute initial checksum for version 0
		const initialChecksum = computeBalanceChecksum(
			{
				balance: 0,
				creditBalance: 0,
				debitBalance: 0,
				pendingDebit: 0,
				pendingCredit: 0,
				lockVersion: 0,
			},
			ctx.options.advanced.hmacSecret,
		);

		// INSERT into account (unified table — static + mutable balance in one row)
		const insertedRows = await tx.raw<{ id: string }>(
			`INSERT INTO ${t("account")} (
				ledger_id, holder_id, holder_type, currency,
				allow_overdraft, overdraft_limit, indicator,
				account_type, account_code, parent_account_id,
				normal_balance, metadata,
				balance, credit_balance, debit_balance,
				pending_debit, pending_credit,
				version, status, checksum
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
			RETURNING id`,
			[
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
				0, 0, 0, 0, 0,
				0,
				"active",
				initialChecksum,
			],
		);

		const inserted = insertedRows[0];
		if (!inserted) throw SummaError.internal("Failed to insert account");
		const accountId = inserted.id;

		// Log status transition
		await tx.raw(
			`INSERT INTO ${t("entity_status_log")} (entity_type, entity_id, status, reason)
			 VALUES ($1, $2, $3, $4)`,
			["account", accountId, "active", "Account created"],
		);

		// Write to outbox for async publishing
		await tx.raw(
			`INSERT INTO ${t("outbox")} (topic, payload)
       VALUES ($1, $2)`,
			[
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

		// Read back the row for response
		const createdRows = await tx.raw<RawAccountRow>(
			`${accountSelectSql(t)} WHERE ledger_id = $1 AND id = $2`,
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
	const rows = await ctx.readAdapter.raw<RawAccountRow>(
		`${accountSelectSql(t)} WHERE ledger_id = $1 AND holder_id = $2 AND is_system = false LIMIT 1`,
		[ledgerId, holderId],
	);

	if (!rows[0]) throw SummaError.notFound("Account not found");
	return rawRowToAccount(rows[0]);
}

/** Resolve account by holderId inside a transaction with FOR UPDATE lock. */
export async function resolveAccountForUpdate(
	tx: SummaTransactionAdapter,
	ledgerId: string,
	holderId: string,
	schema: string,
	lockMode: "wait" | "nowait" | "optimistic" = "wait",
): Promise<RawAccountRow> {
	const t = createTableResolver(schema);

	const isOptimistic = lockMode === "optimistic";
	const lockSuffix = isOptimistic ? "" : lockMode === "nowait" ? "FOR UPDATE NOWAIT" : "FOR UPDATE";

	// Direct read from unified account table — no LATERAL JOIN needed
	const rows = await tx.raw<RawAccountRow>(
		`${accountSelectSql(t)} WHERE ledger_id = $1 AND holder_id = $2 AND is_system = false LIMIT 1 ${lockSuffix}`,
		[ledgerId, holderId],
	);
	if (!rows[0]) throw SummaError.notFound(`Account not found for holder ${holderId}`);
	const row = rows[0];

	// Verify balance checksum (tamper detection)
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
	const rows = await ctx.readAdapter.raw<RawAccountRow>(
		`${accountSelectSql(t)} WHERE ledger_id = $1 AND id = $2 LIMIT 1`,
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
	const rows = await ctx.adapter.raw<RawAccountRow>(
		`${accountSelectSql(t)} WHERE ledger_id = $1 AND id = $2 LIMIT 1`,
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

	const result = await withTransactionTimeout(ctx, async (tx) => {
		const lockedRow = await resolveAccountForUpdate(
			tx,
			ledgerId,
			holderId,
			ctx.options.schema,
			ctx.options.advanced.lockMode,
		);

		if (lockedRow.status === "frozen") {
			return rawRowToAccount(lockedRow);
		}
		if (lockedRow.status === "closed") {
			throw SummaError.accountClosed("Account is closed");
		}

		// UPDATE account with frozen status
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
			`UPDATE ${t("account")} SET
				status = $1, version = $2, checksum = $3,
				freeze_reason = $4, frozen_at = NOW(), frozen_by = $5
			 WHERE id = $6 AND version = $7`,
			["frozen", newVersion, checksum, reason, frozenBy, lockedRow.id, Number(lockedRow.version)],
		);

		// Log status transition
		await tx.raw(
			`INSERT INTO ${t("entity_status_log")} (entity_type, entity_id, status, previous_status, reason, metadata)
			 VALUES ($1, $2, $3, $4, $5, $6)`,
			["account", lockedRow.id, "frozen", lockedRow.status, reason, JSON.stringify({ frozenBy })],
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
			`${accountSelectSql(t)} WHERE ledger_id = $1 AND id = $2`,
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

	const result = await withTransactionTimeout(ctx, async (tx) => {
		const lockedRow = await resolveAccountForUpdate(
			tx,
			ledgerId,
			holderId,
			ctx.options.schema,
			ctx.options.advanced.lockMode,
		);

		if (lockedRow.status === "active") {
			return rawRowToAccount(lockedRow);
		}
		if (lockedRow.status !== "frozen") {
			throw SummaError.conflict(`Cannot unfreeze account in status: ${lockedRow.status}`);
		}

		// UPDATE account with active status, clear freeze fields
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
			`UPDATE ${t("account")} SET
				status = $1, version = $2, checksum = $3,
				freeze_reason = NULL, frozen_at = NULL, frozen_by = NULL
			 WHERE id = $4 AND version = $5`,
			["active", newVersion, checksum, lockedRow.id, Number(lockedRow.version)],
		);

		// Log status transition
		await tx.raw(
			`INSERT INTO ${t("entity_status_log")} (entity_type, entity_id, status, previous_status, reason, metadata)
			 VALUES ($1, $2, $3, $4, $5, $6)`,
			["account", lockedRow.id, "active", "frozen", "unfrozen", JSON.stringify({ unfrozenBy })],
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

		const updatedRows = await tx.raw<RawAccountRow>(
			`${accountSelectSql(t)} WHERE ledger_id = $1 AND id = $2`,
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

	const result = await withTransactionTimeout(ctx, async (tx) => {
		let sweepTxnId: string | null = null;

		// If sweep is needed, resolve destination first (without lock) to get its ID
		let destAccountId: string | null = null;
		if (params.transferToHolderId) {
			const destRows = await tx.raw<{ id: string }>(
				`SELECT id FROM ${t("account")}
         WHERE ledger_id = $1 AND holder_id = $2 AND is_system = false
         LIMIT 1`,
				[ledgerId, params.transferToHolderId],
			);
			if (destRows[0]) destAccountId = destRows[0].id;
		}

		// Lock the source account
		const sourceRow = await resolveAccountForUpdate(
			tx,
			ledgerId,
			holderId,
			ctx.options.schema,
			ctx.options.advanced.lockMode,
		);

		if (sourceRow.status === "closed") {
			return rawRowToAccount(sourceRow);
		}
		if (sourceRow.status === "frozen") {
			throw SummaError.accountFrozen("Cannot close a frozen account. Unfreeze first.");
		}

		// Check for active holds
		const activeHoldRows = await tx.raw<{ count: number }>(
			`SELECT ${ctx.dialect.countAsInt()} AS count FROM ${t("transfer")}
       WHERE source_account_id = $1
         AND is_hold = true
         AND status = 'inflight'`,
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
			const destRows = await tx.raw<{ id: string; status: string; currency: string }>(
				`SELECT id, status, currency FROM ${t("account")} WHERE ledger_id = $1 AND id = $2 FOR UPDATE`,
				[ledgerId, destAccountId],
			);
			if (destRows[0]) {
				destRow = destRows[0];
			}
		}

		const sweepAmount = Number(sourceRow.balance);

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

			// Create sweep transfer
			const sweepTxnRows = await tx.raw<{ id: string }>(
				`INSERT INTO ${t("transfer")} (
					type, status, reference, amount, currency, description,
					source_account_id, destination_account_id,
					correlation_id, metadata, ledger_id, posted_at, effective_date
				) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW())
				RETURNING id`,
				[
					"transfer",
					"posted",
					`sweep_close_${sourceRow.id}`,
					sweepAmount,
					sourceRow.currency,
					`Account closure sweep to ${params.transferToHolderId}`,
					sourceRow.id,
					destRow.id,
					correlationId,
					JSON.stringify({ type: "closure_sweep", closedBy, reason }),
					ledgerId,
				],
			);

			sweepTxnId = sweepTxnRows[0]?.id ?? "";

			// Debit source + update balance
			await insertEntryAndUpdateBalance({
				tx,
				transferId: sweepTxnId,
				accountId: sourceRow.id,
				entryType: "DEBIT",
				amount: sweepAmount,
				currency: sourceRow.currency,
				isHotAccount: false,
				skipLock: true,
			});

			// Credit destination + update balance
			await insertEntryAndUpdateBalance({
				tx,
				transferId: sweepTxnId,
				accountId: destRow.id,
				entryType: "CREDIT",
				amount: sweepAmount,
				currency: sourceRow.currency,
				isHotAccount: false,
			});
		}

		// Close the account — re-read balance (sweep may have changed it)
		const currentRow = await tx.raw<RawAccountRow>(
			`${accountSelectSql(t)} WHERE id = $1`,
			[sourceRow.id],
		);
		const current = currentRow[0];
		if (!current) throw SummaError.internal("Failed to re-read account for close");

		const closeVersion = Number(current.version) + 1;
		const closeChecksum = computeBalanceChecksum(
			{
				balance: Number(current.balance),
				creditBalance: Number(current.credit_balance),
				debitBalance: Number(current.debit_balance),
				pendingDebit: Number(current.pending_debit),
				pendingCredit: Number(current.pending_credit),
				lockVersion: closeVersion,
			},
			ctx.options.advanced.hmacSecret,
		);

		await tx.raw(
			`UPDATE ${t("account")} SET
				status = $1, version = $2, checksum = $3,
				closed_at = NOW(), closed_by = $4, closure_reason = $5
			 WHERE id = $6 AND version = $7`,
			["closed", closeVersion, closeChecksum, closedBy, reason ?? null, sourceRow.id, Number(current.version)],
		);

		// Log status transition
		await tx.raw(
			`INSERT INTO ${t("entity_status_log")} (entity_type, entity_id, status, previous_status, reason, metadata)
			 VALUES ($1, $2, $3, $4, $5, $6)`,
			[
				"account",
				sourceRow.id,
				"closed",
				current.status,
				reason ?? "Account closed",
				JSON.stringify({ closedBy, sweepTransactionId: sweepTxnId }),
			],
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
			`${accountSelectSql(t)} WHERE ledger_id = $1 AND id = $2`,
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
		cursor?: string;
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

	const conditions: string[] = [];
	const queryParams: unknown[] = [];
	let paramIdx = 1;

	conditions.push(`ledger_id = $${paramIdx++}`);
	queryParams.push(ledgerId);

	// Exclude system accounts from listing
	conditions.push(`is_system = false`);

	if (params.status) {
		conditions.push(`status = $${paramIdx++}`);
		queryParams.push(params.status);
	}
	if (params.holderType) {
		conditions.push(`holder_type = $${paramIdx++}`);
		queryParams.push(params.holderType);
	}
	if (params.search) {
		conditions.push(`holder_id = $${paramIdx++}`);
		queryParams.push(params.search);
	}

	const useCursor = params.cursor != null;
	const cursorData = useCursor && params.cursor ? decodeCursor(params.cursor) : null;
	if (useCursor && !cursorData) {
		throw SummaError.invalidArgument("Invalid cursor");
	}

	if (cursorData) {
		conditions.push(
			`(created_at, id) > ($${paramIdx}::timestamptz, $${paramIdx + 1})`,
		);
		queryParams.push(cursorData.ca, cursorData.id);
		paramIdx += 2;
	}

	const whereClause = `WHERE ${conditions.join(" AND ")}`;

	const perPage = Math.min(params.limit ?? params.perPage ?? 20, 100);

	if (useCursor) {
		queryParams.push(perPage + 1);
		const rows = await ctx.readAdapter.raw<RawAccountRow>(
			`${accountSelectSql(t)} ${whereClause}
         ORDER BY created_at ASC, id ASC
         LIMIT $${paramIdx}`,
			queryParams,
		);

		const hasMore = rows.length > perPage;
		const data = (hasMore ? rows.slice(0, perPage) : rows).map(rawRowToAccount);
		const lastRow = hasMore ? rows[perPage - 1] : undefined;
		const nextCursor = lastRow ? encodeCursor(lastRow.created_at, lastRow.id) : undefined;

		return { accounts: data, hasMore, total: -1, nextCursor };
	}

	const page = Math.max(1, params.page ?? 1);
	const offset = (page - 1) * perPage;

	queryParams.push(perPage + 1);
	queryParams.push(offset);
	const rows = await ctx.readAdapter.raw<RawAccountRow & { _total_count: number }>(
		`SELECT *, COUNT(*) OVER()::int AS _total_count FROM ${t("account")}
     ${whereClause}
     ORDER BY created_at ASC
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
// UPDATE OVERDRAFT
// =============================================================================

export async function updateOverdraft(
	ctx: SummaContext,
	params: {
		holderId: string;
		allowOverdraft: boolean;
		overdraftLimit?: number;
	},
): Promise<Account> {
	const { holderId, allowOverdraft, overdraftLimit = 0 } = params;
	const ledgerId = getLedgerId(ctx);
	const t = createTableResolver(ctx.options.schema);

	if (overdraftLimit < 0 || !Number.isInteger(overdraftLimit)) {
		throw SummaError.invalidArgument("overdraftLimit must be a non-negative integer");
	}

	const result = await withTransactionTimeout(ctx, async (tx) => {
		const lockedRow = await resolveAccountForUpdate(
			tx,
			ledgerId,
			holderId,
			ctx.options.schema,
			ctx.options.advanced.lockMode,
		);

		if (lockedRow.status === "closed") {
			throw SummaError.accountClosed("Cannot update overdraft on a closed account");
		}

		// Update the overdraft fields directly on account
		await tx.raw(
			`UPDATE ${t("account")} SET allow_overdraft = $1, overdraft_limit = $2 WHERE id = $3`,
			[allowOverdraft, overdraftLimit, lockedRow.id],
		);

		// Read back
		const updatedRows = await tx.raw<RawAccountRow>(
			`${accountSelectSql(t)} WHERE ledger_id = $1 AND id = $2`,
			[ledgerId, lockedRow.id],
		);
		const updated = updatedRows[0];
		if (!updated) throw SummaError.internal("Failed to read updated account");
		return rawRowToAccount(updated);
	});

	await runAfterOperationHooks(ctx, {
		type: "account.update",
		params: { holderId, allowOverdraft, overdraftLimit },
	});
	return result;
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
