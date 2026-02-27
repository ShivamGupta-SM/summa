// =============================================================================
// HOLD MANAGER -- Inflight transaction lifecycle
// =============================================================================
// Holds reserve funds (pending_debit) until committed, voided, or expired.
//
// v2 changes:
// - transfer table has status as a mutable column (no separate transaction_status)
// - account has mutable balance (no account_balance_version inserts)
// - status transitions logged to entity_status_log
// - entries ARE events (no separate appendEvent)
// - unified account model (system accounts in account table)

import { randomUUID } from "node:crypto";
import type { Hold, HoldDestination, HoldStatus, SummaContext } from "@summa-ledger/core";
import { computeBalanceChecksum, minorToDecimal, SummaError } from "@summa-ledger/core";
import { createTableResolver } from "@summa-ledger/core/db";
import {
	runAfterHoldCommitHooks,
	runAfterOperationHooks,
	runBeforeHoldCreateHooks,
} from "../context/hooks.js";
import { withTransactionTimeout } from "../infrastructure/event-store.js";
import { getAccountByHolder, resolveAccountForUpdate } from "./account-manager.js";
import { checkSufficientBalance } from "./balance-check.js";
import { insertEntryAndUpdateBalance } from "./entry-balance.js";
import {
	checkIdempotencyKeyInTx,
	isValidCachedResult,
	saveIdempotencyKeyInTx,
} from "./idempotency.js";
import { getLedgerId } from "./ledger-helpers.js";
import { enforceLimitsWithAccountId } from "./limit-manager.js";
import { creditMultiDestinations } from "./multi-dest-credit.js";
import type { RawHoldSummaryRow, RawTransferRow } from "./raw-types.js";
import { readAccountBalance, transferSelectSql } from "./sql-helpers.js";
import { getSystemAccount } from "./system-accounts.js";

/**
 * Update the pending_debit on an account and bump version + checksum.
 * Used by hold create/commit/void/expire operations.
 */
async function updatePendingDebit(
	tx: { raw: <T>(sql: string, params: unknown[]) => Promise<T[]> },
	t: (name: string) => string,
	accountId: string,
	pendingDebitDelta: number,
	hmacSecret: string | null | undefined,
): Promise<void> {
	// Read current state
	const current = await readAccountBalance(tx, t, accountId);
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
		`UPDATE ${t("account")} SET
       pending_debit = $1,
       version = $2,
       checksum = $3
     WHERE id = $4 AND version = $5`,
		[newPendingDebit, newVersion, checksum, accountId, Number(current.version)],
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

		// Idempotency check
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
		);
		if (src.status !== "active") {
			throw SummaError.conflict(`Account is ${src.status}`);
		}

		// Limit enforcement
		await enforceLimitsWithAccountId(tx, {
			accountId: src.id,
			holderId,
			amount,
			txnType: "hold",
			category,
		});

		// Check available balance
		const available = Number(src.balance) - Number(src.pending_debit);
		checkSufficientBalance({
			available,
			amount,
			allowOverdraft: src.allow_overdraft,
			overdraftLimit: Number(src.overdraft_limit ?? 0),
		});

		// Resolve destination
		let destAccountId: string | null = null;

		if (params.destinationSystemAccount) {
			const sys = await getSystemAccount(ctx, params.destinationSystemAccount, ledgerId);
			if (!sys)
				throw SummaError.notFound(`System account ${params.destinationSystemAccount} not found`);
			destAccountId = sys.id;
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

		// Create hold transfer record (status = 'inflight')
		const holdRecordRows = await tx.raw<RawTransferRow>(
			`INSERT INTO ${t("transfer")} (ledger_id, type, status, reference, amount, currency, description, source_account_id, destination_account_id, is_hold, hold_expires_at, correlation_id, metadata, effective_date)
       VALUES ($1, $2, 'inflight', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
       RETURNING *`,
			[
				ledgerId,
				"debit",
				reference,
				amount,
				src.currency,
				description,
				src.id,
				destAccountId,
				true,
				holdExpiresAt?.toISOString() ?? null,
				correlationId,
				JSON.stringify({ ...metadata, category, holderId, holderType: src.holder_type }),
			],
		);
		const holdRecord = holdRecordRows[0];
		if (!holdRecord) throw SummaError.internal("Failed to insert hold record");

		// Reserve funds: UPDATE account pending_debit + version + checksum
		await updatePendingDebit(tx, t, src.id, amount, ctx.options.advanced.hmacSecret);

		// Log status
		await tx.raw(
			`INSERT INTO ${t("entity_status_log")} (entity_type, entity_id, status, reason)
       VALUES ('transfer', $1, 'inflight', 'Hold created')`,
			[holdRecord.id],
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

		const response = rawToHoldResponse(holdRecord, src.currency);

		// Save idempotency key
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
		);
		if (src.status !== "active") {
			throw SummaError.conflict(`Account is ${src.status}`);
		}

		// Limit enforcement
		await enforceLimitsWithAccountId(tx, {
			accountId: src.id,
			holderId,
			amount,
			txnType: "hold",
			category,
		});

		// Check available balance
		const available = Number(src.balance) - Number(src.pending_debit);
		checkSufficientBalance({
			available,
			amount,
			allowOverdraft: src.allow_overdraft,
			overdraftLimit: Number(src.overdraft_limit ?? 0),
		});

		const holdExpiresAt =
			expiresInMinutes !== undefined ? new Date(Date.now() + expiresInMinutes * 60 * 1000) : null;
		const correlationId = randomUUID();

		// Create hold transfer record
		const holdRecordRows = await tx.raw<RawTransferRow>(
			`INSERT INTO ${t("transfer")} (ledger_id, type, status, reference, amount, currency, description, source_account_id, is_hold, hold_expires_at, correlation_id, metadata, effective_date)
       VALUES ($1, $2, 'inflight', $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
       RETURNING *`,
			[
				ledgerId,
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
			],
		);
		const holdRecord = holdRecordRows[0];
		if (!holdRecord) throw SummaError.internal("Failed to insert multi-dest hold record");

		// Reserve funds
		await updatePendingDebit(tx, t, src.id, amount, ctx.options.advanced.hmacSecret);

		// Log status
		await tx.raw(
			`INSERT INTO ${t("entity_status_log")} (entity_type, entity_id, status, reason)
       VALUES ('transfer', $1, 'inflight', 'Multi-destination hold created')`,
			[holdRecord.id],
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

		const response = rawToHoldResponse(holdRecord, src.currency);

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

		// Lock the hold transfer with FOR UPDATE, check status directly
		const holdRows = await tx.raw<RawTransferRow>(
			`SELECT * FROM ${t("transfer")}
       WHERE id = $1 AND is_hold = true AND ledger_id = $2
       FOR UPDATE`,
			[holdId, ledgerId],
		);

		const hold = holdRows[0];

		if (!hold || hold.status !== "inflight") {
			if (!hold) throw SummaError.notFound("Hold not found");
			if (hold.status === "expired") throw SummaError.holdExpired("Hold has expired");
			if (hold.status === "posted") throw SummaError.conflict("Hold already committed");
			if (hold.status === "voided") throw SummaError.conflict("Hold was voided");
			throw SummaError.conflict(`Invalid hold status: ${hold.status}`);
		}

		// Check if hold has expired
		if (hold.hold_expires_at) {
			const nowRows = await tx.raw<{ now: Date }>("SELECT NOW() as now", []);
			const dbNow = nowRows[0]?.now;
			if (dbNow && new Date(hold.hold_expires_at) < new Date(dbNow)) {
				// Mark as expired
				await tx.raw(
					`UPDATE ${t("transfer")} SET status = 'expired' WHERE id = $1`,
					[holdId],
				);
				await tx.raw(
					`INSERT INTO ${t("entity_status_log")} (entity_type, entity_id, status, previous_status, reason)
           VALUES ('transfer', $1, 'expired', 'inflight', 'Expired at commit time')`,
					[holdId],
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

		// Lock source account and release FULL hold from pending
		await tx.raw(`SELECT id FROM ${t("account")} WHERE id = $1 FOR UPDATE`, [
			hold.source_account_id,
		]);
		await updatePendingDebit(
			tx,
			t,
			hold.source_account_id as string,
			-holdAmount,
			ctx.options.advanced.hmacSecret,
		);

		// DEBIT source account + create entry
		await insertEntryAndUpdateBalance({
			tx,
			transferId: hold.id,
			accountId: hold.source_account_id as string,
			entryType: "DEBIT",
			amount: commitAmount,
			currency: hold.currency,
			isHotAccount: false,
			skipLock: true,
		});

		// Credit destination(s)
		const metaData = hold.metadata as Record<string, unknown> | null;
		const destinations = (metaData?.destinations ?? []) as HoldDestination[];

		if (destinations.length > 0) {
			// Multi-destination hold
			await creditMultiDestinations(tx, ctx, {
				transferId: hold.id,
				currency: hold.currency,
				totalAmount: commitAmount,
				destinations,
			});
		} else if (hold.destination_account_id) {
			// Credit destination account
			await insertEntryAndUpdateBalance({
				tx,
				transferId: hold.id,
				accountId: hold.destination_account_id,
				entryType: "CREDIT",
				amount: commitAmount,
				currency: hold.currency,
				isHotAccount: false,
			});
		} else {
			// No explicit destination -- credit @World system account
			const worldIdentifier = ctx.options.systemAccounts.world ?? "@World";
			const worldRows = await tx.raw<{ id: string }>(
				`SELECT id FROM ${t("account")} WHERE system_identifier = $1 AND is_system = true LIMIT 1`,
				[worldIdentifier],
			);
			if (!worldRows[0]) {
				throw SummaError.internal(`System account not found: ${worldIdentifier}`);
			}
			await insertEntryAndUpdateBalance({
				tx,
				transferId: hold.id,
				accountId: worldRows[0].id,
				entryType: "CREDIT",
				amount: commitAmount,
				currency: hold.currency,
				isHotAccount: true,
			});
		}

		// Update transfer status to posted
		await tx.raw(
			`UPDATE ${t("transfer")} SET status = 'posted', committed_amount = $1, posted_at = NOW() WHERE id = $2`,
			[commitAmount, holdId],
		);

		// Log status transition
		await tx.raw(
			`INSERT INTO ${t("entity_status_log")} (entity_type, entity_id, status, previous_status, reason)
       VALUES ('transfer', $1, 'posted', 'inflight', 'Hold committed')`,
			[holdId],
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

		// Lock + read hold (status is directly on transfer row)
		const holdRows = await tx.raw<RawTransferRow>(
			`SELECT * FROM ${t("transfer")}
       WHERE id = $1 AND is_hold = true AND ledger_id = $2
       FOR UPDATE`,
			[holdId, ledgerId],
		);

		const hold = holdRows[0];

		if (!hold || hold.status !== "inflight") {
			if (!hold) throw SummaError.notFound("Hold not found");
			if (hold.status === "voided") throw SummaError.conflict("Hold already voided");
			if (hold.status === "posted") throw SummaError.conflict("Hold already committed");
			throw SummaError.conflict(`Invalid hold status: ${hold.status}`);
		}

		const holdAmount = Number(hold.amount);

		// Release pending_debit
		await tx.raw(`SELECT id FROM ${t("account")} WHERE id = $1 FOR UPDATE`, [
			hold.source_account_id,
		]);
		await updatePendingDebit(
			tx,
			t,
			hold.source_account_id as string,
			-holdAmount,
			ctx.options.advanced.hmacSecret,
		);

		// Update transfer status to voided
		await tx.raw(
			`UPDATE ${t("transfer")} SET status = 'voided' WHERE id = $1`,
			[holdId],
		);

		// Log status transition
		await tx.raw(
			`INSERT INTO ${t("entity_status_log")} (entity_type, entity_id, status, previous_status, reason)
       VALUES ('transfer', $1, 'voided', 'inflight', $2)`,
			[holdId, reason],
		);

		// Outbox
		const voidMeta = hold.metadata as Record<string, unknown> | null;
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

	// Find candidate expired holds (status is directly on transfer row)
	const candidates = await ctx.adapter.raw<RawHoldSummaryRow & { ledger_id: string }>(
		`SELECT id, source_account_id, amount, reference, metadata, ledger_id
     FROM ${t("transfer")}
     WHERE is_hold = true
       AND status = 'inflight'
       AND hold_expires_at < NOW()
     LIMIT 100`,
		[],
	);

	for (const candidate of candidates) {
		try {
			await withTransactionTimeout(ctx, async (tx) => {
				// Lock and re-check
				const holdRows = await tx.raw<RawHoldSummaryRow & { status: string }>(
					`SELECT id, source_account_id, amount, reference, metadata, status
           FROM ${t("transfer")}
           WHERE id = $1
             AND status = 'inflight'
             AND hold_expires_at < ${ctx.dialect.now()}
           ${ctx.dialect.forUpdateSkipLocked()}`,
					[candidate.id],
				);

				const hold = holdRows[0];
				if (!hold) return;

				const holdAmount = Number(hold.amount);
				const expireMeta = hold.metadata;

				// Release pending_debit
				await tx.raw(`SELECT id FROM ${t("account")} WHERE id = $1 FOR UPDATE`, [
					hold.source_account_id,
				]);
				await updatePendingDebit(
					tx,
					t,
					hold.source_account_id,
					-holdAmount,
					ctx.options.advanced.hmacSecret,
				);

				// Update transfer status to expired
				await tx.raw(
					`UPDATE ${t("transfer")} SET status = 'expired' WHERE id = $1`,
					[hold.id],
				);

				// Log status transition
				await tx.raw(
					`INSERT INTO ${t("entity_status_log")} (entity_type, entity_id, status, previous_status, reason)
           VALUES ('transfer', $1, 'expired', 'inflight', 'Hold expired')`,
					[hold.id],
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
	const rows = await ctx.readAdapter.raw<RawTransferRow>(
		`${transferSelectSql(t)}
     WHERE id = $1 AND is_hold = true AND ledger_id = $2
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
		"source_account_id = $1",
		"is_hold = true",
		"status = 'inflight'",
	];
	const queryParams: unknown[] = [account.id];
	let paramIdx = 2;

	if (params.category) {
		conditions.push(`metadata->>'category' = $${paramIdx++}`);
		queryParams.push(params.category);
	}

	const whereClause = conditions.join(" AND ");

	const countParams = [...queryParams];
	queryParams.push(perPage + 1);
	queryParams.push(offset);

	const [rows, countRows] = await Promise.all([
		ctx.readAdapter.raw<RawTransferRow>(
			`SELECT * FROM ${t("transfer")}
       WHERE ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${paramIdx++}
       OFFSET $${paramIdx}`,
			queryParams,
		),
		ctx.readAdapter.raw<{ total: number }>(
			`SELECT COUNT(*)::int as total FROM ${t("transfer")}
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

	const conditions: string[] = ["source_account_id = $1", "is_hold = true"];
	const queryParams: unknown[] = [account.id];
	let paramIdx = 2;

	if (params.status) {
		conditions.push(`status = $${paramIdx++}`);
		queryParams.push(params.status);
	}
	if (params.category) {
		conditions.push(`metadata->>'category' = $${paramIdx++}`);
		queryParams.push(params.category);
	}

	const whereClause = conditions.join(" AND ");
	const countParams = [...queryParams];

	queryParams.push(perPage + 1);
	queryParams.push(offset);

	const [rows, countRows] = await Promise.all([
		ctx.readAdapter.raw<RawTransferRow>(
			`SELECT * FROM ${t("transfer")}
       WHERE ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${paramIdx++}
       OFFSET $${paramIdx}`,
			queryParams,
		),
		ctx.readAdapter.raw<{ total: number }>(
			`SELECT COUNT(*)::int as total FROM ${t("transfer")}
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

function rawToHoldResponse(row: RawTransferRow, currency: string): Hold {
	const rawMeta = (row.metadata ?? {}) as Record<string, unknown>;
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
