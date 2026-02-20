// =============================================================================
// ACCOUNT MANAGER -- Account lifecycle operations
// =============================================================================
// Creates, reads, freezes, unfreezes, closes, and lists accounts.
// Uses ctx.adapter for all database operations.

import { randomUUID } from "node:crypto";
import type {
	Account,
	AccountBalance as AccountBalanceType,
	AccountStatus,
	HolderType,
	SummaContext,
	SummaTransactionAdapter,
} from "@summa/core";
import {
	ACCOUNT_EVENTS,
	AGGREGATE_TYPES,
	hashLockKey,
	SummaError,
	TRANSACTION_EVENTS,
} from "@summa/core";
import { appendEvent, withTransactionTimeout } from "../infrastructure/event-store.js";
import type { RawAccountRow, RawBalanceUpdateRow } from "./raw-types.js";

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
		indicator?: string;
		metadata?: Record<string, unknown>;
	},
): Promise<Account> {
	const {
		holderId,
		holderType,
		currency = ctx.options.currency,
		allowOverdraft = false,
		indicator,
		metadata = {},
	} = params;

	if (!holderId || holderId.trim().length === 0) {
		throw SummaError.invalidArgument("holderId must not be empty");
	}

	if (holderId.length > MAX_HOLDER_ID_LENGTH) {
		throw SummaError.invalidArgument(
			`holderId exceeds maximum length of ${MAX_HOLDER_ID_LENGTH} characters`,
		);
	}

	if (currency !== ctx.options.currency) {
		throw SummaError.invalidArgument(
			`Unsupported currency "${currency}". Only "${ctx.options.currency}" is supported.`,
		);
	}

	// Fast path: check if account already exists (no lock needed)
	const existingRows = await ctx.adapter.raw<RawAccountRow>(
		`SELECT * FROM account_balance
     WHERE holder_id = $1 AND holder_type = $2
     LIMIT 1`,
		[holderId, holderType],
	);

	if (existingRows[0]) {
		return rawRowToAccount(existingRows[0]);
	}

	// Slow path: acquire advisory lock to prevent race conditions.
	const lockKey = hashLockKey(`${holderId}:${holderType}`);

	return await withTransactionTimeout(ctx, async (tx) => {
		await tx.raw("SELECT pg_advisory_xact_lock($1)", [lockKey]);

		// Re-check inside lock
		const existingInLockRows = await tx.raw<RawAccountRow>(
			`SELECT * FROM account_balance
       WHERE holder_id = $1 AND holder_type = $2
       LIMIT 1`,
			[holderId, holderType],
		);

		if (existingInLockRows[0]) {
			return rawRowToAccount(existingInLockRows[0]);
		}

		// Insert new account
		const insertedRows = await tx.raw<RawAccountRow>(
			`INSERT INTO account_balance (holder_id, holder_type, currency, allow_overdraft, indicator, status, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
			[
				holderId,
				holderType,
				currency,
				allowOverdraft,
				indicator ?? null,
				"active",
				JSON.stringify(metadata),
			],
		);

		const row = insertedRows[0]!;

		// Append event to event store
		const event = await appendEvent(tx, {
			aggregateType: AGGREGATE_TYPES.ACCOUNT,
			aggregateId: row.id,
			eventType: ACCOUNT_EVENTS.CREATED,
			eventData: {
				holderId,
				holderType,
				currency,
				allowOverdraft,
				indicator,
			},
		});

		// Write to outbox for async publishing
		await tx.raw(
			`INSERT INTO outbox (event_id, topic, payload)
       VALUES ($1, $2, $3)`,
			[
				event.id,
				"ledger-account-created",
				JSON.stringify({
					accountId: row.id,
					holderId,
					holderType,
					currency,
					metadata,
				}),
			],
		);

		return rawRowToAccount(row);
	});
}

// =============================================================================
// GET ACCOUNT
// =============================================================================

export async function getAccountByHolder(ctx: SummaContext, holderId: string): Promise<Account> {
	const rows = await ctx.adapter.raw<RawAccountRow>(
		`SELECT * FROM account_balance
     WHERE holder_id = $1
     LIMIT 1`,
		[holderId],
	);

	if (!rows[0]) throw SummaError.notFound("Account not found");
	return rawRowToAccount(rows[0]);
}

/** Resolve account by holderId inside a transaction with FOR UPDATE lock. */
export async function resolveAccountForUpdate(
	tx: SummaTransactionAdapter,
	holderId: string,
): Promise<RawAccountRow> {
	const rows = await tx.raw<RawAccountRow>(
		`SELECT * FROM account_balance
     WHERE holder_id = $1
     LIMIT 1
     FOR UPDATE`,
		[holderId],
	);
	if (!rows[0]) throw SummaError.notFound(`Account not found for holder ${holderId}`);
	return rows[0];
}

export async function getAccountById(ctx: SummaContext, accountId: string): Promise<Account> {
	const rows = await ctx.adapter.raw<RawAccountRow>(
		`SELECT * FROM account_balance
     WHERE id = $1
     LIMIT 1`,
		[accountId],
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
): Promise<AccountBalanceType> {
	const rows = await ctx.adapter.raw<RawAccountRow>(
		`SELECT * FROM account_balance
     WHERE id = $1
     LIMIT 1`,
		[account.id],
	);

	if (!rows[0]) throw SummaError.notFound("Account not found");

	const row = rows[0];
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

	return await withTransactionTimeout(ctx, async (tx) => {
		// Lock and re-read inside transaction to prevent TOCTOU race
		const lockedRow = await resolveAccountForUpdate(tx, holderId);

		if (lockedRow.status === "frozen") {
			// Idempotent retry -- account already frozen
			const rows = await tx.raw<RawAccountRow>(
				`SELECT * FROM account_balance WHERE id = $1 LIMIT 1`,
				[lockedRow.id],
			);
			return rawRowToAccount(rows[0]!);
		}
		if (lockedRow.status === "closed") {
			throw SummaError.accountClosed("Account is closed");
		}

		const updatedRows = await tx.raw<RawAccountRow>(
			`UPDATE account_balance
       SET status = 'frozen',
           freeze_reason = $1,
           frozen_at = NOW(),
           frozen_by = $2,
           updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
			[reason, frozenBy, lockedRow.id],
		);

		await appendEvent(tx, {
			aggregateType: AGGREGATE_TYPES.ACCOUNT,
			aggregateId: lockedRow.id,
			eventType: ACCOUNT_EVENTS.FROZEN,
			eventData: { reason, frozenBy },
		});

		await tx.raw(
			`INSERT INTO outbox (topic, payload)
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

		return rawRowToAccount(updatedRows[0]!);
	});
}

export async function unfreezeAccount(
	ctx: SummaContext,
	params: {
		holderId: string;
		unfrozenBy: string;
	},
): Promise<Account> {
	const { holderId, unfrozenBy } = params;

	return await withTransactionTimeout(ctx, async (tx) => {
		const lockedRow = await resolveAccountForUpdate(tx, holderId);

		if (lockedRow.status === "active") {
			// Idempotent retry -- account already active
			const rows = await tx.raw<RawAccountRow>(
				`SELECT * FROM account_balance WHERE id = $1 LIMIT 1`,
				[lockedRow.id],
			);
			return rawRowToAccount(rows[0]!);
		}
		if (lockedRow.status !== "frozen") {
			throw SummaError.conflict(`Cannot unfreeze account in status: ${lockedRow.status}`);
		}

		const updatedRows = await tx.raw<RawAccountRow>(
			`UPDATE account_balance
       SET status = 'active',
           freeze_reason = NULL,
           frozen_at = NULL,
           frozen_by = NULL,
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
			[lockedRow.id],
		);

		await appendEvent(tx, {
			aggregateType: AGGREGATE_TYPES.ACCOUNT,
			aggregateId: lockedRow.id,
			eventType: ACCOUNT_EVENTS.UNFROZEN,
			eventData: { unfrozenBy },
		});

		await tx.raw(
			`INSERT INTO outbox (topic, payload)
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

		return rawRowToAccount(updatedRows[0]!);
	});
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

	return await withTransactionTimeout(ctx, async (tx) => {
		let sweepTxnId: string | null = null;

		// If sweep is needed, resolve destination first (without lock) to get its ID
		let destAccountId: string | null = null;
		if (params.transferToHolderId) {
			const destRows = await tx.raw<{ id: string }>(
				`SELECT id FROM account_balance
         WHERE holder_id = $1
         LIMIT 1`,
				[params.transferToHolderId],
			);
			if (destRows[0]) destAccountId = destRows[0].id;
		}

		// Lock the source account inside the transaction (prevents TOCTOU race)
		const sourceRow = await resolveAccountForUpdate(tx, holderId);

		// Status checks INSIDE transaction after acquiring lock
		if (sourceRow.status === "closed") {
			const rows = await tx.raw<RawAccountRow>(
				`SELECT * FROM account_balance WHERE id = $1 LIMIT 1`,
				[sourceRow.id],
			);
			return rawRowToAccount(rows[0]!);
		}
		if (sourceRow.status === "frozen") {
			throw SummaError.accountFrozen("Cannot close a frozen account. Unfreeze first.");
		}

		// Check for active holds
		const activeHoldRows = await tx.raw<{ count: number }>(
			`SELECT COUNT(*)::int AS count FROM transaction_record
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
				`SELECT id, status, currency FROM account_balance WHERE id = $1 FOR UPDATE`,
				[destAccountId],
			);
			destRow = destRows[0] ?? null;
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

			// Create sweep transaction record
			const sweepTxnRows = await tx.raw<{ id: string; reference: string }>(
				`INSERT INTO transaction_record (reference, status, amount, currency, description, source_account_id, destination_account_id, correlation_id, meta_data, posted_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
         RETURNING id, reference`,
				[
					`sweep_close_${sourceRow.id}`,
					"posted",
					sweepAmount,
					sourceRow.currency,
					`Account closure sweep to ${params.transferToHolderId}`,
					sourceRow.id,
					destRow.id,
					correlationId,
					JSON.stringify({ type: "closure_sweep", closedBy, reason }),
				],
			);

			sweepTxnId = sweepTxnRows[0]?.id;

			// Debit source
			const debitUpdateRows = await tx.raw<RawBalanceUpdateRow>(
				`UPDATE account_balance
         SET balance = balance - $1,
             debit_balance = debit_balance + $1,
             lock_version = lock_version + 1,
             updated_at = NOW()
         WHERE id = $2
         RETURNING balance + $1 as balance_before, balance as balance_after, lock_version`,
				[sweepAmount, sourceRow.id],
			);
			const debitUpdate = debitUpdateRows[0]!;

			await tx.raw(
				`INSERT INTO entry_record (transaction_id, account_id, entry_type, amount, currency, balance_before, balance_after, account_lock_version, is_hot_account)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
				[
					sweepTxnId,
					sourceRow.id,
					"DEBIT",
					sweepAmount,
					sourceRow.currency,
					debitUpdate.balance_before,
					debitUpdate.balance_after,
					debitUpdate.lock_version,
					false,
				],
			);

			// Credit destination
			const creditUpdateRows = await tx.raw<RawBalanceUpdateRow>(
				`UPDATE account_balance
         SET balance = balance + $1,
             credit_balance = credit_balance + $1,
             lock_version = lock_version + 1,
             updated_at = NOW()
         WHERE id = $2
         RETURNING balance - $1 as balance_before, balance as balance_after, lock_version`,
				[sweepAmount, destRow.id],
			);
			const creditUpdate = creditUpdateRows[0]!;

			await tx.raw(
				`INSERT INTO entry_record (transaction_id, account_id, entry_type, amount, currency, balance_before, balance_after, account_lock_version, is_hot_account)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
				[
					sweepTxnId,
					destRow.id,
					"CREDIT",
					sweepAmount,
					sourceRow.currency,
					creditUpdate.balance_before,
					creditUpdate.balance_after,
					creditUpdate.lock_version,
					false,
				],
			);

			// Event for sweep
			await appendEvent(tx, {
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
			});
		}

		// Close the account
		const updatedRows = await tx.raw<RawAccountRow>(
			`UPDATE account_balance
       SET status = 'closed',
           closed_at = NOW(),
           closed_by = $1,
           closure_reason = $2,
           updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
			[closedBy, reason ?? null, sourceRow.id],
		);

		await appendEvent(tx, {
			aggregateType: AGGREGATE_TYPES.ACCOUNT,
			aggregateId: sourceRow.id,
			eventType: ACCOUNT_EVENTS.CLOSED,
			eventData: {
				closedBy,
				reason,
				finalBalance: sweepAmount,
				sweepTransactionId: sweepTxnId,
			},
		});

		await tx.raw(
			`INSERT INTO outbox (topic, payload)
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

		return rawRowToAccount(updatedRows[0]!);
	});
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
	},
): Promise<{ accounts: Account[]; hasMore: boolean; total: number }> {
	const page = Math.max(1, params.page ?? 1);
	const perPage = Math.min(params.perPage ?? 20, 100);
	const offset = (page - 1) * perPage;

	// Build dynamic WHERE conditions
	const conditions: string[] = [];
	const countConditions: string[] = [];
	const queryParams: unknown[] = [];
	const countParams: unknown[] = [];
	let paramIdx = 1;
	let countParamIdx = 1;

	if (params.status) {
		conditions.push(`status = $${paramIdx++}`);
		queryParams.push(params.status);
		countConditions.push(`status = $${countParamIdx++}`);
		countParams.push(params.status);
	}
	if (params.holderType) {
		conditions.push(`holder_type = $${paramIdx++}`);
		queryParams.push(params.holderType);
		countConditions.push(`holder_type = $${countParamIdx++}`);
		countParams.push(params.holderType);
	}
	if (params.search) {
		conditions.push(`holder_id = $${paramIdx++}`);
		queryParams.push(params.search);
		countConditions.push(`holder_id = $${countParamIdx++}`);
		countParams.push(params.search);
	}

	const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
	const countWhereClause =
		countConditions.length > 0 ? `WHERE ${countConditions.join(" AND ")}` : "";

	// Fetch rows + 1 to detect hasMore
	queryParams.push(perPage + 1);
	queryParams.push(offset);
	const rows = await ctx.adapter.raw<RawAccountRow>(
		`SELECT * FROM account_balance
     ${whereClause}
     ORDER BY created_at ASC
     LIMIT $${paramIdx++}
     OFFSET $${paramIdx}`,
		queryParams,
	);

	// Count query
	const countRows = await ctx.adapter.raw<{ total: number }>(
		`SELECT COUNT(*)::int as total FROM account_balance ${countWhereClause}`,
		countParams,
	);

	const hasMore = rows.length > perPage;
	const data = (hasMore ? rows.slice(0, perPage) : rows).map(rawRowToAccount);

	return { accounts: data, hasMore, total: countRows[0]?.total ?? 0 };
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
		freezeReason: row.freeze_reason ?? null,
		frozenAt: row.frozen_at ? new Date(row.frozen_at) : null,
		frozenBy: row.frozen_by ?? null,
		closedAt: row.closed_at ? new Date(row.closed_at) : null,
		closedBy: row.closed_by ?? null,
		closureReason: row.closure_reason ?? null,
		metadata: (row.metadata ?? {}) as Record<string, unknown>,
		createdAt: new Date(row.created_at),
		updatedAt: new Date(row.updated_at),
	};
}
