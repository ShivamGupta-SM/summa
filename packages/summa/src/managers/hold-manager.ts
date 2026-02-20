// =============================================================================
// HOLD MANAGER -- Inflight transaction lifecycle
// =============================================================================
// Holds reserve funds (pending_debit) until committed, voided, or expired.
// Uses FOR UPDATE to prevent race conditions with expiry cron.

import { randomUUID } from "node:crypto";
import type { Hold, HoldDestination, HoldStatus, SummaContext } from "@summa/core";
import { AGGREGATE_TYPES, HOLD_EVENTS, minorToDecimal, SummaError } from "@summa/core";
import { appendEvent, withTransactionTimeout } from "../infrastructure/event-store.js";
import { getAccountByHolder, resolveAccountForUpdate } from "./account-manager.js";
import { checkIdempotencyKeyInTx, saveIdempotencyKeyInTx } from "./idempotency.js";
import { enforceLimitsWithAccountId } from "./limit-manager.js";
import { creditMultiDestinations } from "./multi-dest-credit.js";
import type { RawBalanceUpdateRow, RawHoldSummaryRow, RawTransactionRow } from "./raw-types.js";
import { getSystemAccount } from "./system-accounts.js";

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

	return await withTransactionTimeout(ctx, async (tx) => {
		// Idempotency check INSIDE transaction
		const idem = await checkIdempotencyKeyInTx(tx, {
			idempotencyKey: params.idempotencyKey,
			reference,
		});
		if (idem.alreadyProcessed) {
			return idem.cachedResult as Hold;
		}

		// Get source account (FOR UPDATE to prevent stale balance reads)
		const src = await resolveAccountForUpdate(tx, holderId);
		if (src.status !== "active") {
			throw SummaError.conflict(`Account is ${src.status}`);
		}

		// Limit enforcement inside tx
		await enforceLimitsWithAccountId(ctx, {
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

		// Resolve destination
		let destAccountId: string | null = null;
		let destSystemAccountId: string | null = null;

		if (params.destinationSystemAccount) {
			const sys = await getSystemAccount(ctx, params.destinationSystemAccount);
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

		// Create hold transaction
		const holdRecordRows = await tx.raw<RawTransactionRow>(
			`INSERT INTO transaction_record (reference, status, amount, currency, description, source_account_id, destination_account_id, destination_system_account_id, is_hold, hold_expires_at, correlation_id, meta_data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
			[
				reference,
				"inflight",
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
			],
		);
		const holdRecord = holdRecordRows[0]!;

		// Reserve funds (increase pending_debit)
		await tx.raw(
			`UPDATE account_balance
       SET pending_debit = pending_debit + $1,
           lock_version = lock_version + 1,
           updated_at = NOW()
       WHERE id = $2`,
			[amount, src.id],
		);

		// Event store
		await appendEvent(tx, {
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
		});

		// Outbox
		await tx.raw(`INSERT INTO outbox (topic, payload) VALUES ($1, $2)`, [
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

		// Save idempotency key inside transaction for atomicity
		if (params.idempotencyKey) {
			await saveIdempotencyKeyInTx(tx, {
				key: params.idempotencyKey,
				reference,
				resultData: response,
			});
		}

		return response;
	});
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

	return await withTransactionTimeout(ctx, async (tx) => {
		const idem = await checkIdempotencyKeyInTx(tx, {
			idempotencyKey: params.idempotencyKey,
			reference,
		});
		if (idem.alreadyProcessed) {
			return idem.cachedResult as Hold;
		}

		// Get source account (FOR UPDATE)
		const src = await resolveAccountForUpdate(tx, holderId);
		if (src.status !== "active") {
			throw SummaError.conflict(`Account is ${src.status}`);
		}

		// Limit enforcement inside tx
		await enforceLimitsWithAccountId(ctx, {
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

		const holdExpiresAt =
			expiresInMinutes !== undefined ? new Date(Date.now() + expiresInMinutes * 60 * 1000) : null;
		const correlationId = randomUUID();

		// Create hold transaction -- store destinations in metadata for commit resolution
		const holdRecordRows = await tx.raw<RawTransactionRow>(
			`INSERT INTO transaction_record (reference, status, amount, currency, description, source_account_id, is_hold, hold_expires_at, correlation_id, meta_data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
			[
				reference,
				"inflight",
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
		const holdRecord = holdRecordRows[0]!;

		// Reserve funds (increase pending_debit)
		await tx.raw(
			`UPDATE account_balance
       SET pending_debit = pending_debit + $1,
           lock_version = lock_version + 1,
           updated_at = NOW()
       WHERE id = $2`,
			[amount, src.id],
		);

		// Event store
		await appendEvent(tx, {
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
		});

		// Outbox
		await tx.raw(`INSERT INTO outbox (topic, payload) VALUES ($1, $2)`, [
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
				key: params.idempotencyKey,
				reference,
				resultData: response,
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

	return await withTransactionTimeout(ctx, async (tx) => {
		// Lock the hold record with FOR UPDATE to prevent cron race
		const holdRows = await tx.raw<RawTransactionRow>(
			`SELECT * FROM transaction_record
       WHERE id = $1
         AND is_hold = true
         AND status = 'inflight'
       FOR UPDATE`,
			[holdId],
		);

		const hold = holdRows[0];

		if (!hold) {
			// Check if it exists in a different status
			const existingRows = await tx.raw<RawTransactionRow>(
				`SELECT * FROM transaction_record WHERE id = $1 LIMIT 1`,
				[holdId],
			);
			const existing = existingRows[0];

			if (!existing) throw SummaError.notFound("Hold not found");
			if (existing.status === "expired") throw SummaError.conflict("Hold has expired");
			if (existing.status === "posted") {
				// Idempotent retry -- return cached committed result
				return {
					holdId,
					committedAmount: Number(existing.committed_amount ?? existing.amount),
					originalAmount: Number(existing.amount),
				};
			}
			if (existing.status === "voided") throw SummaError.conflict("Hold was voided");
			throw SummaError.conflict(`Invalid hold status: ${existing.status}`);
		}

		// Check if hold has expired -- use DB time to avoid client clock skew
		if (hold.hold_expires_at) {
			const nowRows = await tx.raw<{ now: Date }>("SELECT NOW() as now", []);
			const dbNow = nowRows[0]?.now;
			if (dbNow && new Date(hold.hold_expires_at) < new Date(dbNow)) {
				await tx.raw(`UPDATE transaction_record SET status = 'expired' WHERE id = $1`, [holdId]);
				throw SummaError.conflict("Hold has expired");
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

		// Release FULL hold from pending, debit ACTUAL commit amount
		const debitUpdateRows = await tx.raw<RawBalanceUpdateRow>(
			`UPDATE account_balance
       SET pending_debit = pending_debit - $1,
           balance = balance - $2,
           debit_balance = debit_balance + $2,
           lock_version = lock_version + 1,
           updated_at = NOW()
       WHERE id = $3
       RETURNING balance + $2 as balance_before, balance as balance_after, lock_version`,
			[holdAmount, commitAmount, hold.source_account_id],
		);
		const debitUpdate = debitUpdateRows[0]!;

		// Create DEBIT entry record for source account
		await tx.raw(
			`INSERT INTO entry_record (transaction_id, account_id, entry_type, amount, currency, balance_before, balance_after, account_lock_version, is_hot_account)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
			[
				hold.id,
				hold.source_account_id,
				"DEBIT",
				commitAmount,
				hold.currency,
				debitUpdate.balance_before,
				debitUpdate.balance_after,
				debitUpdate.lock_version,
				false,
			],
		);

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
			const creditUpdateRows = await tx.raw<RawBalanceUpdateRow>(
				`UPDATE account_balance
         SET balance = balance + $1,
             credit_balance = credit_balance + $1,
             lock_version = lock_version + 1,
             updated_at = NOW()
         WHERE id = $2
         RETURNING balance - $1 as balance_before, balance as balance_after, lock_version`,
				[commitAmount, hold.destination_account_id],
			);
			const creditUpdate = creditUpdateRows[0];

			if (!creditUpdate) {
				throw SummaError.internal("Destination account not found during hold commit");
			}

			await tx.raw(
				`INSERT INTO entry_record (transaction_id, account_id, entry_type, amount, currency, balance_before, balance_after, account_lock_version, is_hot_account)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
				[
					hold.id,
					hold.destination_account_id,
					"CREDIT",
					commitAmount,
					hold.currency,
					creditUpdate.balance_before,
					creditUpdate.balance_after,
					creditUpdate.lock_version,
					false,
				],
			);
		} else if (hold.destination_system_account_id) {
			// Hot account pattern for system accounts
			await tx.raw(
				`INSERT INTO hot_account_entry (account_id, amount, entry_type, transaction_id, status)
         VALUES ($1, $2, $3, $4, $5)`,
				[hold.destination_system_account_id, commitAmount, "CREDIT", hold.id, "pending"],
			);
			await tx.raw(
				`INSERT INTO entry_record (transaction_id, system_account_id, entry_type, amount, currency, is_hot_account)
         VALUES ($1, $2, $3, $4, $5, $6)`,
				[hold.id, hold.destination_system_account_id, "CREDIT", commitAmount, hold.currency, true],
			);
		}

		// Update hold status
		await tx.raw(
			`UPDATE transaction_record
       SET status = 'posted',
           committed_amount = $1,
           posted_at = NOW()
       WHERE id = $2`,
			[commitAmount, holdId],
		);

		// Event store
		await appendEvent(tx, {
			aggregateType: AGGREGATE_TYPES.HOLD,
			aggregateId: holdId,
			eventType: HOLD_EVENTS.COMMITTED,
			eventData: {
				committedAmount: commitAmount,
				originalAmount: holdAmount,
			},
		});

		// Outbox
		await tx.raw(`INSERT INTO outbox (topic, payload) VALUES ($1, $2)`, [
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

	return await withTransactionTimeout(ctx, async (tx) => {
		// Lock with FOR UPDATE
		const holdRows = await tx.raw<RawTransactionRow>(
			`SELECT * FROM transaction_record
       WHERE id = $1
         AND is_hold = true
         AND status = 'inflight'
       FOR UPDATE`,
			[holdId],
		);

		const hold = holdRows[0];

		if (!hold) {
			const existingRows = await tx.raw<RawTransactionRow>(
				`SELECT * FROM transaction_record WHERE id = $1 LIMIT 1`,
				[holdId],
			);
			const existing = existingRows[0];

			if (!existing) throw SummaError.notFound("Hold not found");
			if (existing.status === "voided") {
				return { holdId, amount: Number(existing.amount) };
			}
			if (existing.status === "posted") throw SummaError.conflict("Hold already committed");
			throw SummaError.conflict(`Invalid hold status: ${existing.status}`);
		}

		const holdAmount = Number(hold.amount);

		// Release pending_debit
		await tx.raw(
			`UPDATE account_balance
       SET pending_debit = pending_debit - $1,
           lock_version = lock_version + 1,
           updated_at = NOW()
       WHERE id = $2`,
			[holdAmount, hold.source_account_id],
		);

		// Update hold status
		await tx.raw(`UPDATE transaction_record SET status = 'voided' WHERE id = $1`, [holdId]);

		// Event store
		await appendEvent(tx, {
			aggregateType: AGGREGATE_TYPES.HOLD,
			aggregateId: holdId,
			eventType: HOLD_EVENTS.VOIDED,
			eventData: { reason },
		});

		// Outbox
		const voidMeta = hold.meta_data as Record<string, unknown> | null;
		await tx.raw(`INSERT INTO outbox (topic, payload) VALUES ($1, $2)`, [
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
}

// =============================================================================
// EXPIRE HOLDS (called by cron job)
// =============================================================================

export async function expireHolds(ctx: SummaContext): Promise<{ expired: number }> {
	let expired = 0;

	// Find candidate expired holds (no lock -- just a lightweight scan)
	const candidates = await ctx.adapter.raw<RawHoldSummaryRow>(
		`SELECT id, source_account_id, amount, reference, meta_data
     FROM transaction_record
     WHERE is_hold = true
       AND status = 'inflight'
       AND hold_expires_at < NOW()
     LIMIT 100`,
		[],
	);

	for (const candidate of candidates) {
		try {
			await withTransactionTimeout(ctx, async (tx) => {
				// Lock the hold row and re-check status + expiry atomically
				const holdRows = await tx.raw<RawHoldSummaryRow>(
					`SELECT id, source_account_id, amount, reference, meta_data
           FROM transaction_record
           WHERE id = $1
             AND status = 'inflight'
             AND hold_expires_at < NOW()
           FOR UPDATE SKIP LOCKED`,
					[candidate.id],
				);

				const hold = holdRows[0];
				if (!hold) return; // Already committed/voided/expired or locked by another process

				const holdAmount = Number(hold.amount);
				const expireMeta = hold.meta_data;

				// Release pending_debit
				await tx.raw(
					`UPDATE account_balance
           SET pending_debit = pending_debit - $1,
               lock_version = lock_version + 1,
               updated_at = NOW()
           WHERE id = $2`,
					[holdAmount, hold.source_account_id],
				);

				// Mark as expired
				await tx.raw(`UPDATE transaction_record SET status = 'expired' WHERE id = $1`, [hold.id]);

				// Event store
				await appendEvent(tx, {
					aggregateType: AGGREGATE_TYPES.HOLD,
					aggregateId: hold.id,
					eventType: HOLD_EVENTS.EXPIRED,
					eventData: { expiredAt: new Date().toISOString() },
				});

				// Outbox
				await tx.raw(`INSERT INTO outbox (topic, payload) VALUES ($1, $2)`, [
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
	const rows = await ctx.adapter.raw<RawTransactionRow>(
		`SELECT * FROM transaction_record
     WHERE id = $1 AND is_hold = true
     LIMIT 1`,
		[holdId],
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
): Promise<{ holds: Hold[]; hasMore: boolean; total?: number }> {
	const page = Math.max(1, params.page ?? 1);
	const perPage = Math.min(params.perPage ?? 20, 100);
	const offset = (page - 1) * perPage;

	const account = await getAccountByHolder(ctx, params.holderId);

	const conditions: string[] = ["source_account_id = $1", "is_hold = true", "status = 'inflight'"];
	const queryParams: unknown[] = [account.id];
	let paramIdx = 2;

	if (params.category) {
		conditions.push(`meta_data->>'category' = $${paramIdx++}`);
		queryParams.push(params.category);
	}

	const whereClause = conditions.join(" AND ");

	// Fetch rows + count
	queryParams.push(perPage + 1);
	queryParams.push(offset);

	const [rows, countRows] = await Promise.all([
		ctx.adapter.raw<RawTransactionRow>(
			`SELECT * FROM transaction_record
       WHERE ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${paramIdx++}
       OFFSET $${paramIdx}`,
			queryParams,
		),
		ctx.adapter.raw<{ total: number }>(
			`SELECT COUNT(*)::int as total FROM transaction_record
       WHERE ${whereClause}`,
			queryParams.slice(0, params.category ? 2 : 1),
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
): Promise<{ holds: Hold[]; hasMore: boolean; total?: number }> {
	const page = Math.max(1, params.page ?? 1);
	const perPage = Math.min(params.perPage ?? 20, 100);
	const offset = (page - 1) * perPage;

	const account = await getAccountByHolder(ctx, params.holderId);

	const conditions: string[] = ["source_account_id = $1", "is_hold = true"];
	const queryParams: unknown[] = [account.id];
	const countParams: unknown[] = [account.id];
	let paramIdx = 2;
	let _countParamIdx = 2;

	if (params.status) {
		conditions.push(`status = $${paramIdx++}`);
		queryParams.push(params.status);
		countParams.push(params.status);
		_countParamIdx++;
	}
	if (params.category) {
		conditions.push(`meta_data->>'category' = $${paramIdx++}`);
		queryParams.push(params.category);
		countParams.push(params.category);
		_countParamIdx++;
	}

	const whereClause = conditions.join(" AND ");

	queryParams.push(perPage + 1);
	queryParams.push(offset);

	const [rows, countRows] = await Promise.all([
		ctx.adapter.raw<RawTransactionRow>(
			`SELECT * FROM transaction_record
       WHERE ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${paramIdx++}
       OFFSET $${paramIdx}`,
			queryParams,
		),
		ctx.adapter.raw<{ total: number }>(
			`SELECT COUNT(*)::int as total FROM transaction_record
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

function rawToHoldResponse(row: RawTransactionRow, currency: string): Hold {
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
		metadata: (row.meta_data ?? {}) as Record<string, unknown>,
		expiresAt: row.hold_expires_at
			? row.hold_expires_at instanceof Date
				? row.hold_expires_at.toISOString()
				: String(row.hold_expires_at)
			: null,
		createdAt:
			row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
	};
}
