// =============================================================================
// HOLD MANAGER -- Inflight transaction lifecycle (APPEND-ONLY)
// =============================================================================
// Holds reserve funds (pending_debit) until committed, voided, or expired.
//
// After the immutability refactor:
// - account_balance is IMMUTABLE, state lives in account_balance_version (append-only)
// - transaction_record is IMMUTABLE, status lives in transaction_status (append-only)
// - All balance changes INSERT new version rows
// - All status changes INSERT new transaction_status rows

import { randomUUID } from "node:crypto";
import type { Hold, HoldDestination, HoldStatus, SummaContext } from "@summa-ledger/core";
import {
	AGGREGATE_TYPES,
	computeBalanceChecksum,
	HOLD_EVENTS,
	minorToDecimal,
	SummaError,
} from "@summa-ledger/core";
import { createTableResolver } from "@summa-ledger/core/db";
import {
	runAfterHoldCommitHooks,
	runAfterOperationHooks,
	runBeforeHoldCreateHooks,
} from "../context/hooks.js";
import { appendEvent, withTransactionTimeout } from "../infrastructure/event-store.js";
import { getAccountByHolder, resolveAccountForUpdate } from "./account-manager.js";
import { insertEntryAndUpdateBalance } from "./entry-balance.js";
import {
	checkIdempotencyKeyInTx,
	isValidCachedResult,
	saveIdempotencyKeyInTx,
} from "./idempotency.js";
import { getLedgerId } from "./ledger-helpers.js";
import { enforceLimitsWithAccountId } from "./limit-manager.js";
import { creditMultiDestinations } from "./multi-dest-credit.js";
import type { LatestVersion, RawHoldSummaryRow, RawTransactionRow } from "./raw-types.js";
import { readLatestVersion, txnWithStatusSql } from "./sql-helpers.js";
import { getSystemAccount } from "./system-accounts.js";

/**
 * Insert a new account_balance_version row with updated pending_debit.
 * Used by hold create/commit/void/expire operations.
 */
async function insertPendingDebitVersion(
	tx: { raw: <T>(sql: string, params: unknown[]) => Promise<T[]> },
	t: (name: string) => string,
	accountId: string,
	current: LatestVersion,
	pendingDebitDelta: number,
	changeType: string,
	hmacSecret: string | null | undefined,
	causedByTransactionId?: string,
): Promise<void> {
	const newPendingDebit = Number(current.pending_debit) + pendingDebitDelta;
	const newVersion = Number(current.version) + 1;
	const checksum = computeBalanceChecksum(
		{
			balance: Number(current.balance),
			creditBalance: Number(current.credit_balance),
			debitBalance: Number(current.debit_balance),
			pendingDebit: newPendingDebit,
			pendingCredit: Number(current.pending_credit),
			lockVersion: newVersion,
		},
		hmacSecret,
	);

	await tx.raw(
		`INSERT INTO ${t("account_balance_version")} (
       account_id, version, balance, credit_balance, debit_balance,
       pending_credit, pending_debit, status, checksum,
       freeze_reason, frozen_at, frozen_by,
       closed_at, closed_by, closure_reason,
       change_type, caused_by_transaction_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
		[
			accountId,
			newVersion,
			Number(current.balance),
			Number(current.credit_balance),
			Number(current.debit_balance),
			Number(current.pending_credit),
			newPendingDebit,
			current.status,
			checksum,
			current.freeze_reason,
			current.frozen_at,
			current.frozen_by,
			current.closed_at,
			current.closed_by,
			current.closure_reason,
			changeType,
			causedByTransactionId ?? null,
		],
	);
}

// =============================================================================
// CREATE HOLD
// =============================================================================

export async function createHold(
	ctx: SummaContext,
	params: {
		holderId: string;
		amount: number;
		reference: string;
		description?: string;
		category?: string;
		destinationHolderId?: string;
		destinationSystemAccount?: string;
		expiresInMinutes?: number;
		metadata?: Record<string, unknown>;
		idempotencyKey?: string;
	},
): Promise<Hold> {
	const {
		holderId,
		amount,
		reference,
		description = "",
		category = "hold",
		expiresInMinutes,
		metadata = {},
	} = params;

	if (
		!Number.isInteger(amount) ||
		amount <= 0 ||
		amount > ctx.options.advanced.maxTransactionAmount
	) {
		throw SummaError.invalidArgument(
			"Amount must be a positive integer (in smallest currency units) and not exceed maximum limit",
		);
	}

	await runBeforeHoldCreateHooks(ctx, { holderId, amount, reference, ctx });

	const ledgerId = getLedgerId(ctx);

	const result = await withTransactionTimeout(ctx, async (tx) => {
		const t = createTableResolver(ctx.options.schema);

		// Idempotency check INSIDE transaction
		const idem = await checkIdempotencyKeyInTx(tx, {
			ledgerId,
			idempotencyKey: params.idempotencyKey,
			reference,
		});
		if (idem.alreadyProcessed && isValidCachedResult(idem.cachedResult)) {
			return idem.cachedResult as Hold;
		}

		// Get source account (FOR UPDATE to prevent stale balance reads)
		const src = await resolveAccountForUpdate(
			tx,
			ledgerId,
			holderId,
			ctx.options.schema,
			ctx.options.advanced.lockMode,
			ctx.options.advanced.useDenormalizedBalance,
		);
		if (src.status !== "active") {
			throw SummaError.conflict(`Account is ${src.status}`);
		}

		// Limit enforcement inside tx
		await enforceLimitsWithAccountId(tx, {
			accountId: src.id,
			holderId,
			amount,
			txnType: "hold",
			category,
		});

		// Check available balance
		const available = Number(src.balance) - Number(src.pending_debit);
		if (!src.allow_overdraft && available < amount) {
			throw SummaError.insufficientBalance(
				`Insufficient balance. Available: ${available}, Required: ${amount}`,
			);
		}
		if (src.allow_overdraft) {
			const overdraftLimit = Number(src.overdraft_limit ?? 0);
			if (overdraftLimit > 0 && available - amount < -overdraftLimit) {
				throw SummaError.insufficientBalance(
					`Hold would exceed overdraft limit of ${overdraftLimit}. Available (incl. overdraft): ${available + overdraftLimit}, Required: ${amount}`,
				);
			}
		}

		// Resolve destination
		let destAccountId: string | null = null;
		let destSystemAccountId: string | null = null;

		if (params.destinationSystemAccount) {
			const sys = await getSystemAccount(ctx, params.destinationSystemAccount, ledgerId);
			if (!sys)
				throw SummaError.notFound(`System account ${params.destinationSystemAccount} not found`);
			destSystemAccountId = sys.id;
		} else if (params.destinationHolderId) {
			const dest = await getAccountByHolder(ctx, params.destinationHolderId);
			if (dest.status !== "active") {
				throw SummaError.conflict(`Destination account is ${dest.status}`);
			}
			if (dest.currency !== src.currency) {
				throw SummaError.invalidArgument(
					`Currency mismatch: source is ${src.currency}, destination is ${dest.currency}`,
				);
			}
			destAccountId = dest.id;
		}

		const holdExpiresAt =
			expiresInMinutes !== undefined ? new Date(Date.now() + expiresInMinutes * 60 * 1000) : null;
		const correlationId = randomUUID();

		// Create hold transaction record (IMMUTABLE — no status field)
		const holdRecordRows = await tx.raw<RawTransactionRow>(
			`INSERT INTO ${t("transaction_record")} (type, reference, amount, currency, description, source_account_id, destination_account_id, destination_system_account_id, is_hold, hold_expires_at, correlation_id, meta_data, ledger_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING *`,
			[
				"debit",
				reference,
				amount,
				src.currency,
				description,
				src.id,
				destAccountId,
				destSystemAccountId,
				true,
				holdExpiresAt?.toISOString() ?? null,
				correlationId,
				JSON.stringify({ ...metadata, category, holderId, holderType: src.holder_type }),
				ledgerId,
			],
		);
		const holdRecord = holdRecordRows[0];
		if (!holdRecord) throw SummaError.internal("Failed to insert hold record");

		// INSERT initial transaction_status (APPEND-ONLY)
		await tx.raw(
			`INSERT INTO ${t("transaction_status")} (transaction_id, status)
       VALUES ($1, $2)`,
			[holdRecord.id, "inflight"],
		);

		// Reserve funds: INSERT new account_balance_version with increased pending_debit
		const currentVersion = await readLatestVersion(tx, t, src.id);
		await insertPendingDebitVersion(
			tx,
			t,
			src.id,
			currentVersion,
			amount,
			"hold_create",
			ctx.options.advanced.hmacSecret,
			holdRecord.id,
		);

		// Event store
		await appendEvent(
			tx,
			{
				aggregateType: AGGREGATE_TYPES.HOLD,
				aggregateId: holdRecord.id,
				eventType: HOLD_EVENTS.CREATED,
				eventData: {
					sourceAccountId: src.id,
					destinationAccountId: destAccountId,
					destinationSystemAccountId: destSystemAccountId,
					amount,
					expiresAt: holdExpiresAt?.toISOString() ?? null,
					reference,
				},
				correlationId,
			},
			ctx.options.schema,
			ctx.options.advanced.hmacSecret,
			ledgerId,
		);

		// Outbox
		await tx.raw(`INSERT INTO ${t("outbox")} (topic, payload) VALUES ($1, $2)`, [
			"ledger-hold-created",
			JSON.stringify({
				holdId: holdRecord.id,
				accountId: src.id,
				holderId,
				holderType: src.holder_type,
				amount,
				reference,
				category,
				metadata,
			}),
		]);

		// Build response — inject status from what we just inserted
		const response = rawToHoldResponse({ ...holdRecord, status: "inflight" }, src.currency);

		// Save idempotency key inside transaction for atomicity
		if (params.idempotencyKey) {
			await saveIdempotencyKeyInTx(tx, {
				ledgerId,
				key: params.idempotencyKey,
				reference,
				resultData: response,
				ttlMs: ctx.options.advanced.idempotencyTTL,
			});
		}

		return response;
	});

	await runAfterOperationHooks(ctx, {
		type: "hold.create",
		params: { holderId, amount, reference },
	});
	return result;
}

// =============================================================================
// CREATE MULTI-DESTINATION HOLD
// =============================================================================

export async function createMultiDestinationHold(
	ctx: SummaContext,
	params: {
		holderId: string;
		amount: number;
		reference: string;
		description?: string;
		category?: string;
		destinations: HoldDestination[];
		expiresInMinutes?: number;
		metadata?: Record<string, unknown>;
		idempotencyKey?: string;
	},
): Promise<Hold> {
	const {
		holderId,
		amount,
		reference,
		description = "Multi-destination hold",
		category = "hold",
		destinations,
		expiresInMinutes,
		metadata = {},
	} = params;

	if (
		!Number.isInteger(amount) ||
		amount <= 0 ||
		amount > ctx.options.advanced.maxTransactionAmount
	) {
		throw SummaError.invalidArgument(
			"Amount must be a positive integer (in smallest currency units) and not exceed maximum limit",
		);
	}

	if (!destinations || destinations.length === 0) {
		throw SummaError.invalidArgument("At least one destination is required");
	}

	// Validate destination amounts don't exceed hold total
	const explicitSum = destinations.reduce((sum, d) => sum + (d.amount ?? 0), 0);
	if (explicitSum > amount) {
		throw SummaError.invalidArgument(
			`Sum of destination amounts (${explicitSum}) exceeds hold total (${amount})`,
		);
	}

	const ledgerId = getLedgerId(ctx);

	return await withTransactionTimeout(ctx, async (tx) => {
		const t = createTableResolver(ctx.options.schema);

		const idem = await checkIdempotencyKeyInTx(tx, {
			ledgerId,
			idempotencyKey: params.idempotencyKey,
			reference,
		});
		if (idem.alreadyProcessed && isValidCachedResult(idem.cachedResult)) {
			return idem.cachedResult as Hold;
		}

		// Get source account (FOR UPDATE)
		const src = await resolveAccountForUpdate(
			tx,
			ledgerId,
			holderId,
			ctx.options.schema,
			ctx.options.advanced.lockMode,
			ctx.options.advanced.useDenormalizedBalance,
		);
		if (src.status !== "active") {
			throw SummaError.conflict(`Account is ${src.status}`);
		}

		// Limit enforcement inside tx
		await enforceLimitsWithAccountId(tx, {
			accountId: src.id,
			holderId,
			amount,
			txnType: "hold",
			category,
		});

		// Check available balance
		const available = Number(src.balance) - Number(src.pending_debit);
		if (!src.allow_overdraft && available < amount) {
			throw SummaError.insufficientBalance(
				`Insufficient balance. Available: ${available}, Required: ${amount}`,
			);
		}
		if (src.allow_overdraft) {
			const overdraftLimit = Number(src.overdraft_limit ?? 0);
			if (overdraftLimit > 0 && available - amount < -overdraftLimit) {
				throw SummaError.insufficientBalance(
					`Hold would exceed overdraft limit of ${overdraftLimit}. Available (incl. overdraft): ${available + overdraftLimit}, Required: ${amount}`,
				);
			}
		}

		const holdExpiresAt =
			expiresInMinutes !== undefined ? new Date(Date.now() + expiresInMinutes * 60 * 1000) : null;
		const correlationId = randomUUID();

		// Create hold transaction record (IMMUTABLE — no status field)
		const holdRecordRows = await tx.raw<RawTransactionRow>(
			`INSERT INTO ${t("transaction_record")} (type, reference, amount, currency, description, source_account_id, is_hold, hold_expires_at, correlation_id, meta_data, ledger_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
			[
				"debit",
				reference,
				amount,
				src.currency,
				description,
				src.id,
				true,
				holdExpiresAt?.toISOString() ?? null,
				correlationId,
				JSON.stringify({
					...metadata,
					category,
					destinations,
					holderId,
					holderType: src.holder_type,
				}),
				ledgerId,
			],
		);
		const holdRecord = holdRecordRows[0];
		if (!holdRecord) throw SummaError.internal("Failed to insert multi-dest hold record");

		// INSERT initial transaction_status (APPEND-ONLY)
		await tx.raw(
			`INSERT INTO ${t("transaction_status")} (transaction_id, status)
       VALUES ($1, $2)`,
			[holdRecord.id, "inflight"],
		);

		// Reserve funds: INSERT new account_balance_version with increased pending_debit
		const currentVersion = await readLatestVersion(tx, t, src.id);
		await insertPendingDebitVersion(
			tx,
			t,
			src.id,
			currentVersion,
			amount,
			"hold_create",
			ctx.options.advanced.hmacSecret,
			holdRecord.id,
		);

		// Event store
		await appendEvent(
			tx,
			{
				aggregateType: AGGREGATE_TYPES.HOLD,
				aggregateId: holdRecord.id,
				eventType: HOLD_EVENTS.CREATED,
				eventData: {
					sourceAccountId: src.id,
					amount,
					destinations: destinations.length,
					expiresAt: holdExpiresAt?.toISOString() ?? null,
					reference,
				},
				correlationId,
			},
			ctx.options.schema,
			ctx.options.advanced.hmacSecret,
			ledgerId,
		);

		// Outbox
		await tx.raw(`INSERT INTO ${t("outbox")} (topic, payload) VALUES ($1, $2)`, [
			"ledger-hold-created",
			JSON.stringify({
				holdId: holdRecord.id,
				accountId: src.id,
				holderId,
				holderType: src.holder_type,
				amount,
				reference,
				category,
				isMultiDestination: true,
			}),
		]);

		const response = rawToHoldResponse({ ...holdRecord, status: "inflight" }, src.currency);

		if (params.idempotencyKey) {
			await saveIdempotencyKeyInTx(tx, {
				ledgerId,
				key: params.idempotencyKey,
				reference,
				resultData: response,
				ttlMs: ctx.options.advanced.idempotencyTTL,
			});
		}

		return response;
	});
}

// =============================================================================
// COMMIT HOLD
// =============================================================================

export async function commitHold(
	ctx: SummaContext,
	params: {
		holdId: string;
		amount?: number;
	},
): Promise<{ holdId: string; committedAmount: number; originalAmount: number }> {
	const { holdId } = params;
	const ledgerId = getLedgerId(ctx);

	const result = await withTransactionTimeout(ctx, async (tx) => {
		const t = createTableResolver(ctx.options.schema);

		// Lock the hold record with FOR UPDATE to prevent cron race.
		// Read latest status via LATERAL JOIN.
		const holdRows = await tx.raw<RawTransactionRow>(
			`SELECT tr.*, ts.status, ts.committed_amount, ts.refunded_amount, ts.posted_at
       FROM ${t("transaction_record")} tr
       JOIN LATERAL (
         SELECT status, committed_amount, refunded_amount, posted_at
         FROM ${t("transaction_status")}
         WHERE transaction_id = tr.id
         ORDER BY created_at DESC LIMIT 1
       ) ts ON true
       WHERE tr.id = $1
         AND tr.is_hold = true
         AND tr.ledger_id = $2
       FOR UPDATE OF tr`,
			[holdId, ledgerId],
		);

		const hold = holdRows[0];

		if (!hold || hold.status !== "inflight") {
			// Check if it exists in a different status
			const existingRows = await tx.raw<RawTransactionRow>(
				`${txnWithStatusSql(t)} WHERE tr.id = $1 LIMIT 1`,
				[holdId],
			);
			const existing = existingRows[0];

			if (!existing) throw SummaError.notFound("Hold not found");
			if (existing.status === "expired") throw SummaError.holdExpired("Hold has expired");
			if (existing.status === "posted") throw SummaError.conflict("Hold already committed");
			if (existing.status === "voided") throw SummaError.conflict("Hold was voided");
			throw SummaError.conflict(`Invalid hold status: ${existing.status}`);
		}

		// Check if hold has expired -- use DB time to avoid client clock skew
		if (hold.hold_expires_at) {
			const nowRows = await tx.raw<{ now: Date }>("SELECT NOW() as now", []);
			const dbNow = nowRows[0]?.now;
			if (dbNow && new Date(hold.hold_expires_at) < new Date(dbNow)) {
				// INSERT expired status (APPEND-ONLY)
				await tx.raw(
					`INSERT INTO ${t("transaction_status")} (transaction_id, status, reason)
           VALUES ($1, $2, $3)`,
					[holdId, "expired", "Expired at commit time"],
				);
				throw SummaError.holdExpired("Hold has expired");
			}
		}

		const commitAmount = params.amount ?? Number(hold.amount);
		const holdAmount = Number(hold.amount);

		if (params.amount !== undefined && (!Number.isInteger(commitAmount) || commitAmount <= 0)) {
			throw SummaError.invalidArgument("Commit amount must be a positive integer");
		}

		if (commitAmount > holdAmount) {
			throw SummaError.invalidArgument(
				`Commit amount ${commitAmount} exceeds hold amount ${holdAmount}`,
			);
		}

		// Release FULL hold from pending: INSERT new version with reduced pending_debit
		// Lock the account parent, read latest version
		await tx.raw(`SELECT id FROM ${t("account_balance")} WHERE id = $1 FOR UPDATE`, [
			hold.source_account_id,
		]);
		const releaseCurrent = await readLatestVersion(tx, t, hold.source_account_id as string);
		await insertPendingDebitVersion(
			tx,
			t,
			hold.source_account_id as string,
			releaseCurrent,
			-holdAmount,
			"hold_release",
			ctx.options.advanced.hmacSecret,
			holdId,
		);

		// DEBIT source account + update balance
		await insertEntryAndUpdateBalance({
			tx,
			transactionId: hold.id,
			accountId: hold.source_account_id,
			entryType: "DEBIT",
			amount: commitAmount,
			currency: hold.currency,
			isHotAccount: false,
			updateDenormalizedCache: ctx.options.advanced.useDenormalizedBalance,
		});

		// Credit destination(s)
		const metaData = hold.meta_data as Record<string, unknown> | null;
		const destinations = (metaData?.destinations ?? []) as HoldDestination[];

		if (destinations.length > 0) {
			// Multi-destination hold
			await creditMultiDestinations(tx, ctx, {
				transactionId: hold.id,
				currency: hold.currency,
				totalAmount: commitAmount,
				destinations,
			});
		} else if (hold.destination_account_id) {
			// Credit destination + update balance
			await insertEntryAndUpdateBalance({
				tx,
				transactionId: hold.id,
				accountId: hold.destination_account_id,
				entryType: "CREDIT",
				amount: commitAmount,
				currency: hold.currency,
				isHotAccount: false,
				updateDenormalizedCache: ctx.options.advanced.useDenormalizedBalance,
			});
		} else if (hold.destination_system_account_id) {
			// Hot account pattern for system accounts
			await tx.raw(
				`INSERT INTO ${t("hot_account_entry")} (account_id, amount, entry_type, transaction_id, status)
         VALUES ($1, $2, $3, $4, $5)`,
				[hold.destination_system_account_id, commitAmount, "CREDIT", hold.id, "pending"],
			);
			await insertEntryAndUpdateBalance({
				tx,
				transactionId: hold.id,
				systemAccountId: hold.destination_system_account_id,
				entryType: "CREDIT",
				amount: commitAmount,
				currency: hold.currency,
				isHotAccount: true,
			});
		} else {
			// No explicit destination -- credit the @World system account to maintain double-entry invariant
			const worldIdentifier = ctx.options.systemAccounts.world ?? "@World";
			const worldRows = await tx.raw<{ id: string }>(
				`SELECT id FROM ${t("system_account")} WHERE identifier = $1 LIMIT 1`,
				[worldIdentifier],
			);
			if (!worldRows[0]) {
				throw SummaError.internal(`System account not found: ${worldIdentifier}`);
			}
			const worldId = worldRows[0].id;

			await tx.raw(
				`INSERT INTO ${t("hot_account_entry")} (account_id, amount, entry_type, transaction_id, status)
         VALUES ($1, $2, $3, $4, $5)`,
				[worldId, commitAmount, "CREDIT", hold.id, "pending"],
			);
			await insertEntryAndUpdateBalance({
				tx,
				transactionId: hold.id,
				systemAccountId: worldId,
				entryType: "CREDIT",
				amount: commitAmount,
				currency: hold.currency,
				isHotAccount: true,
			});
		}

		// INSERT posted status (APPEND-ONLY — replaces UPDATE transaction_record SET status)
		await tx.raw(
			`INSERT INTO ${t("transaction_status")} (transaction_id, status, committed_amount, posted_at)
       VALUES ($1, $2, $3, NOW())`,
			[holdId, "posted", commitAmount],
		);

		// Event store
		await appendEvent(
			tx,
			{
				aggregateType: AGGREGATE_TYPES.HOLD,
				aggregateId: holdId,
				eventType: HOLD_EVENTS.COMMITTED,
				eventData: {
					committedAmount: commitAmount,
					originalAmount: holdAmount,
				},
			},
			ctx.options.schema,
			ctx.options.advanced.hmacSecret,
			ledgerId,
		);

		// Outbox
		await tx.raw(`INSERT INTO ${t("outbox")} (topic, payload) VALUES ($1, $2)`, [
			"ledger-hold-committed",
			JSON.stringify({
				holdId,
				accountId: hold.source_account_id,
				holderId: metaData?.holderId ?? "",
				holderType: metaData?.holderType ?? "",
				amount: commitAmount,
				reference: hold.reference,
				category: metaData?.category ?? "hold",
				metadata: metaData ?? {},
			}),
		]);

		return {
			holdId,
			committedAmount: commitAmount,
			originalAmount: holdAmount,
		};
	});

	await runAfterHoldCommitHooks(ctx, {
		holdId,
		committedAmount: result.committedAmount,
		originalAmount: result.originalAmount,
		ctx,
	});
	await runAfterOperationHooks(ctx, {
		type: "hold.commit",
		params: { holdId, amount: result.committedAmount },
	});
	return result;
}

// =============================================================================
// VOID HOLD
// =============================================================================

export async function voidHold(
	ctx: SummaContext,
	params: {
		holdId: string;
		reason?: string;
	},
): Promise<{ holdId: string; amount: number }> {
	const { holdId, reason = "voided" } = params;
	const ledgerId = getLedgerId(ctx);

	const result = await withTransactionTimeout(ctx, async (tx) => {
		const t = createTableResolver(ctx.options.schema);

		// Lock with FOR UPDATE + read latest status
		const holdRows = await tx.raw<RawTransactionRow>(
			`SELECT tr.*, ts.status, ts.committed_amount, ts.refunded_amount, ts.posted_at
       FROM ${t("transaction_record")} tr
       JOIN LATERAL (
         SELECT status, committed_amount, refunded_amount, posted_at
         FROM ${t("transaction_status")}
         WHERE transaction_id = tr.id
         ORDER BY created_at DESC LIMIT 1
       ) ts ON true
       WHERE tr.id = $1
         AND tr.is_hold = true
         AND tr.ledger_id = $2
       FOR UPDATE OF tr`,
			[holdId, ledgerId],
		);

		const hold = holdRows[0];

		if (!hold || hold.status !== "inflight") {
			const existingRows = await tx.raw<RawTransactionRow>(
				`${txnWithStatusSql(t)} WHERE tr.id = $1 LIMIT 1`,
				[holdId],
			);
			const existing = existingRows[0];

			if (!existing) throw SummaError.notFound("Hold not found");
			if (existing.status === "voided") throw SummaError.conflict("Hold already voided");
			if (existing.status === "posted") throw SummaError.conflict("Hold already committed");
			throw SummaError.conflict(`Invalid hold status: ${existing.status}`);
		}

		const holdAmount = Number(hold.amount);

		// Release pending_debit: lock account, read latest version, insert new version
		await tx.raw(`SELECT id FROM ${t("account_balance")} WHERE id = $1 FOR UPDATE`, [
			hold.source_account_id,
		]);
		const voidCurrent = await readLatestVersion(tx, t, hold.source_account_id as string);
		await insertPendingDebitVersion(
			tx,
			t,
			hold.source_account_id as string,
			voidCurrent,
			-holdAmount,
			"hold_release",
			ctx.options.advanced.hmacSecret,
			holdId,
		);

		// INSERT voided status (APPEND-ONLY)
		await tx.raw(
			`INSERT INTO ${t("transaction_status")} (transaction_id, status, reason)
       VALUES ($1, $2, $3)`,
			[holdId, "voided", reason],
		);

		// Event store
		await appendEvent(
			tx,
			{
				aggregateType: AGGREGATE_TYPES.HOLD,
				aggregateId: holdId,
				eventType: HOLD_EVENTS.VOIDED,
				eventData: { reason },
			},
			ctx.options.schema,
			ctx.options.advanced.hmacSecret,
			ledgerId,
		);

		// Outbox
		const voidMeta = hold.meta_data as Record<string, unknown> | null;
		await tx.raw(`INSERT INTO ${t("outbox")} (topic, payload) VALUES ($1, $2)`, [
			"ledger-hold-voided",
			JSON.stringify({
				holdId,
				accountId: hold.source_account_id,
				holderId: voidMeta?.holderId ?? "",
				holderType: voidMeta?.holderType ?? "",
				amount: holdAmount,
				reference: hold.reference,
				category: voidMeta?.category ?? "hold",
				metadata: voidMeta ?? {},
			}),
		]);

		return { holdId, amount: holdAmount };
	});

	await runAfterOperationHooks(ctx, { type: "hold.void", params: { holdId } });
	return result;
}

export async function expireHolds(ctx: SummaContext): Promise<{ expired: number }> {
	const t = createTableResolver(ctx.options.schema);
	let expired = 0;

	// Find candidate expired holds using LATERAL JOIN to get latest status
	const candidates = await ctx.adapter.raw<RawHoldSummaryRow & { ledger_id: string }>(
		`SELECT tr.id, tr.source_account_id, tr.amount, tr.reference, tr.meta_data, tr.ledger_id
     FROM ${t("transaction_record")} tr
     JOIN LATERAL (
       SELECT status FROM ${t("transaction_status")}
       WHERE transaction_id = tr.id
       ORDER BY created_at DESC LIMIT 1
     ) ts ON true
     WHERE tr.is_hold = true
       AND ts.status = 'inflight'
       AND tr.hold_expires_at < NOW()
     LIMIT 100`,
		[],
	);

	for (const candidate of candidates) {
		try {
			await withTransactionTimeout(ctx, async (tx) => {
				// Lock the hold row and re-check status + expiry atomically
				const holdRows = await tx.raw<RawHoldSummaryRow & { status: string }>(
					`SELECT tr.id, tr.source_account_id, tr.amount, tr.reference, tr.meta_data, ts.status
           FROM ${t("transaction_record")} tr
           JOIN LATERAL (
             SELECT status FROM ${t("transaction_status")}
             WHERE transaction_id = tr.id
             ORDER BY created_at DESC LIMIT 1
           ) ts ON true
           WHERE tr.id = $1
             AND ts.status = 'inflight'
             AND tr.hold_expires_at < ${ctx.dialect.now()}
           ${ctx.dialect.forUpdateSkipLocked()}`,
					[candidate.id],
				);

				const hold = holdRows[0];
				if (!hold) return; // Already committed/voided/expired or locked by another process

				const holdAmount = Number(hold.amount);
				const expireMeta = hold.meta_data;

				// Release pending_debit: lock account, read latest version, insert new version
				await tx.raw(`SELECT id FROM ${t("account_balance")} WHERE id = $1 FOR UPDATE`, [
					hold.source_account_id,
				]);
				const expCurrent = await readLatestVersion(tx, t, hold.source_account_id);
				await insertPendingDebitVersion(
					tx,
					t,
					hold.source_account_id,
					expCurrent,
					-holdAmount,
					"hold_release",
					ctx.options.advanced.hmacSecret,
					candidate.id,
				);

				// INSERT expired status (APPEND-ONLY)
				await tx.raw(
					`INSERT INTO ${t("transaction_status")} (transaction_id, status, reason)
           VALUES ($1, $2, $3)`,
					[hold.id, "expired", "Hold expired"],
				);

				// Event store
				await appendEvent(
					tx,
					{
						aggregateType: AGGREGATE_TYPES.HOLD,
						aggregateId: hold.id,
						eventType: HOLD_EVENTS.EXPIRED,
						eventData: { expiredAt: new Date().toISOString() },
					},
					ctx.options.schema,
					ctx.options.advanced.hmacSecret,
					candidate.ledger_id,
				);

				// Outbox
				await tx.raw(`INSERT INTO ${t("outbox")} (topic, payload) VALUES ($1, $2)`, [
					"ledger-hold-expired",
					JSON.stringify({
						holdId: hold.id,
						accountId: hold.source_account_id,
						holderId: expireMeta?.holderId ?? "",
						holderType: expireMeta?.holderType ?? "",
						amount: holdAmount,
						reference: hold.reference,
						category: expireMeta?.category ?? "hold",
						metadata: expireMeta ?? {},
					}),
				]);

				expired++;
			});
		} catch (error) {
			ctx.logger.error("Failed to expire hold", {
				holdId: candidate.id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	if (expired > 0) {
		ctx.logger.info("Expired holds", { count: expired });
	}

	return { expired };
}

// =============================================================================
// GET / LIST HOLDS
// =============================================================================

export async function getHold(ctx: SummaContext, holdId: string): Promise<Hold> {
	const ledgerId = getLedgerId(ctx);
	const t = createTableResolver(ctx.options.schema);
	const rows = await ctx.readAdapter.raw<RawTransactionRow>(
		`${txnWithStatusSql(t)}
     WHERE tr.id = $1 AND tr.is_hold = true AND tr.ledger_id = $2
     LIMIT 1`,
		[holdId, ledgerId],
	);

	if (!rows[0]) throw SummaError.notFound("Hold not found");
	return rawToHoldResponse(rows[0], rows[0].currency);
}

export async function listActiveHolds(
	ctx: SummaContext,
	params: {
		holderId: string;
		page?: number;
		perPage?: number;
		category?: string;
	},
): Promise<{ holds: Hold[]; hasMore: boolean; total: number }> {
	const page = Math.max(1, params.page ?? 1);
	const perPage = Math.min(params.perPage ?? 20, 100);
	const offset = (page - 1) * perPage;

	const account = await getAccountByHolder(ctx, params.holderId);
	const t = createTableResolver(ctx.options.schema);

	const conditions: string[] = [
		"tr.source_account_id = $1",
		"tr.is_hold = true",
		"ts.status = 'inflight'",
	];
	const queryParams: unknown[] = [account.id];
	let paramIdx = 2;

	if (params.category) {
		conditions.push(`tr.meta_data->>'category' = $${paramIdx++}`);
		queryParams.push(params.category);
	}

	const whereClause = conditions.join(" AND ");

	// Fetch rows + count
	queryParams.push(perPage + 1);
	queryParams.push(offset);

	const countParams: unknown[] = [account.id];
	if (params.category) countParams.push(params.category);

	const countConditions: string[] = [
		"tr.source_account_id = $1",
		"tr.is_hold = true",
		"ts.status = 'inflight'",
	];
	let countParamIdx = 2;
	if (params.category) {
		countConditions.push(`tr.meta_data->>'category' = $${countParamIdx++}`);
	}
	const countWhere = countConditions.join(" AND ");

	const [rows, countRows] = await Promise.all([
		ctx.readAdapter.raw<RawTransactionRow>(
			`${txnWithStatusSql(t)}
       WHERE ${whereClause}
       ORDER BY tr.created_at DESC
       LIMIT $${paramIdx++}
       OFFSET $${paramIdx}`,
			queryParams,
		),
		ctx.readAdapter.raw<{ total: number }>(
			`SELECT COUNT(*)::int as total FROM ${t("transaction_record")} tr
       JOIN LATERAL (
         SELECT status FROM ${t("transaction_status")}
         WHERE transaction_id = tr.id ORDER BY created_at DESC LIMIT 1
       ) ts ON true
       WHERE ${countWhere}`,
			countParams,
		),
	]);

	const hasMore = rows.length > perPage;
	const holds = (hasMore ? rows.slice(0, perPage) : rows).map((r) =>
		rawToHoldResponse(r, r.currency),
	);

	return { holds, hasMore, total: countRows[0]?.total ?? 0 };
}

export async function listAllHolds(
	ctx: SummaContext,
	params: {
		holderId: string;
		page?: number;
		perPage?: number;
		category?: string;
		status?: "inflight" | "posted" | "voided" | "expired";
	},
): Promise<{ holds: Hold[]; hasMore: boolean; total: number }> {
	const VALID_HOLD_STATUSES: ReadonlySet<string> = new Set([
		"inflight",
		"posted",
		"voided",
		"expired",
	]);
	if (params.status && !VALID_HOLD_STATUSES.has(params.status)) {
		throw SummaError.invalidArgument(
			`Invalid hold status: "${params.status}". Must be one of: inflight, posted, voided, expired`,
		);
	}

	const page = Math.max(1, params.page ?? 1);
	const perPage = Math.min(params.perPage ?? 20, 100);
	const offset = (page - 1) * perPage;

	const account = await getAccountByHolder(ctx, params.holderId);
	const t = createTableResolver(ctx.options.schema);

	const conditions: string[] = ["tr.source_account_id = $1", "tr.is_hold = true"];
	const queryParams: unknown[] = [account.id];
	const countParams: unknown[] = [account.id];
	let paramIdx = 2;

	if (params.status) {
		conditions.push(`ts.status = $${paramIdx++}`);
		queryParams.push(params.status);
		countParams.push(params.status);
	}
	if (params.category) {
		conditions.push(`tr.meta_data->>'category' = $${paramIdx++}`);
		queryParams.push(params.category);
		countParams.push(params.category);
	}

	const whereClause = conditions.join(" AND ");

	queryParams.push(perPage + 1);
	queryParams.push(offset);

	const [rows, countRows] = await Promise.all([
		ctx.readAdapter.raw<RawTransactionRow>(
			`${txnWithStatusSql(t)}
       WHERE ${whereClause}
       ORDER BY tr.created_at DESC
       LIMIT $${paramIdx++}
       OFFSET $${paramIdx}`,
			queryParams,
		),
		ctx.readAdapter.raw<{ total: number }>(
			`SELECT COUNT(*)::int as total FROM ${t("transaction_record")} tr
       JOIN LATERAL (
         SELECT status FROM ${t("transaction_status")}
         WHERE transaction_id = tr.id ORDER BY created_at DESC LIMIT 1
       ) ts ON true
       WHERE ${whereClause}`,
			countParams,
		),
	]);

	const hasMore = rows.length > perPage;
	const holds = (hasMore ? rows.slice(0, perPage) : rows).map((r) =>
		rawToHoldResponse(r, r.currency),
	);

	return { holds, hasMore, total: countRows[0]?.total ?? 0 };
}

// =============================================================================
// HELPERS
// =============================================================================

/** Internal metadata keys that should not leak into the public Hold.metadata */
const INTERNAL_META_KEYS = new Set(["holderId", "holderType", "category", "destinations"]);

function rawToHoldResponse(row: RawTransactionRow, currency: string): Hold {
	// Strip internal fields from metadata before returning to caller
	const rawMeta = (row.meta_data ?? {}) as Record<string, unknown>;
	const metadata: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(rawMeta)) {
		if (!INTERNAL_META_KEYS.has(key)) {
			metadata[key] = value;
		}
	}

	return {
		id: row.id,
		sourceAccountId: row.source_account_id ?? "",
		destinationAccountId: row.destination_account_id,
		amount: Number(row.amount),
		amountDecimal: minorToDecimal(Number(row.amount), currency),
		committedAmount: row.committed_amount != null ? Number(row.committed_amount) : null,
		currency: row.currency,
		status: row.status as HoldStatus,
		reference: row.reference,
		description: row.description ?? "",
		metadata,
		expiresAt: row.hold_expires_at
			? row.hold_expires_at instanceof Date
				? row.hold_expires_at.toISOString()
				: String(row.hold_expires_at)
			: null,
		createdAt:
			row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
	};
}
