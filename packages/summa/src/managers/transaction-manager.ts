// =============================================================================
// TRANSACTION MANAGER -- Double-entry transaction operations
// =============================================================================
// Every transaction creates balanced debit + credit entry records.
// System accounts use hot account pattern for high-volume batching.

import { randomUUID } from "node:crypto";
import type {
	HoldDestination,
	LedgerTransaction,
	SummaContext,
	TransactionStatus,
	TransactionType,
} from "@summa/core";
import { AGGREGATE_TYPES, minorToDecimal, SummaError, TRANSACTION_EVENTS } from "@summa/core";
import { runAfterTransactionHooks, runBeforeTransactionHooks } from "../context/hooks.js";
import { appendEvent, withTransactionTimeout } from "../infrastructure/event-store.js";
import { resolveAccountForUpdate } from "./account-manager.js";
import { checkIdempotencyKeyInTx, saveIdempotencyKeyInTx } from "./idempotency.js";
import { enforceLimitsWithAccountId, logTransactionInTx } from "./limit-manager.js";
import { creditMultiDestinations } from "./multi-dest-credit.js";
import type { RawAccountRow, RawBalanceUpdateRow, RawTransactionRow } from "./raw-types.js";

// =============================================================================
// CREDIT ACCOUNT
// =============================================================================

export async function creditAccount(
	ctx: SummaContext,
	params: {
		holderId: string;
		amount: number;
		reference: string;
		description?: string;
		category?: string;
		metadata?: Record<string, unknown>;
		sourceSystemAccount?: string;
		idempotencyKey?: string;
	},
): Promise<LedgerTransaction> {
	const {
		holderId,
		amount,
		reference,
		description = "",
		category = "credit",
		metadata = {},
		sourceSystemAccount = ctx.options.systemAccounts.world ?? "@World",
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

	const hookParams = { type: "credit" as const, amount, reference, holderId, category, ctx };
	await runBeforeTransactionHooks(ctx, hookParams);

	const result = await withTransactionTimeout(ctx, async (tx) => {
		// Idempotency check INSIDE transaction for atomicity
		const idem = await checkIdempotencyKeyInTx(tx, {
			idempotencyKey: params.idempotencyKey,
			reference,
		});
		if (idem.alreadyProcessed) {
			return idem.cachedResult as LedgerTransaction;
		}

		// Get destination account (FOR UPDATE to prevent stale reads)
		const destAccount = await resolveAccountForUpdate(tx, holderId);
		if (destAccount.status !== "active") {
			if (destAccount.status === "frozen") throw SummaError.accountFrozen();
			if (destAccount.status === "closed") throw SummaError.accountClosed();
			throw SummaError.conflict(`Account is ${destAccount.status}`);
		}

		// Limit enforcement inside tx
		await enforceLimitsWithAccountId(ctx, {
			accountId: destAccount.id,
			holderId,
			amount,
			txnType: "credit",
			category,
		});

		// Get source system account
		const systemRows = await tx.raw<{ id: string }>(
			`SELECT id FROM system_account WHERE identifier = $1 LIMIT 1`,
			[sourceSystemAccount],
		);
		if (!systemRows[0]) {
			throw SummaError.notFound(`System account not found: ${sourceSystemAccount}`);
		}
		const sourceSystemId = systemRows[0].id;

		const correlationId = randomUUID();
		const acctCurrency = destAccount.currency;

		// Create transaction record
		const txnRecordRows = await tx.raw<RawTransactionRow>(
			`INSERT INTO transaction_record (reference, status, amount, currency, description, destination_account_id, source_system_account_id, correlation_id, meta_data, posted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
       RETURNING *`,
			[
				reference,
				"posted",
				amount,
				acctCurrency,
				description,
				destAccount.id,
				sourceSystemId,
				correlationId,
				JSON.stringify({ ...metadata, category }),
			],
		);
		const txnRecord = txnRecordRows[0]!;

		// CREDIT destination account (atomic balance update)
		const creditUpdateRows = await tx.raw<RawBalanceUpdateRow>(
			`UPDATE account_balance
       SET balance = balance + $1,
           credit_balance = credit_balance + $1,
           lock_version = lock_version + 1,
           updated_at = NOW()
       WHERE id = $2
       RETURNING balance - $1 as balance_before, balance as balance_after, lock_version`,
			[amount, destAccount.id],
		);
		const creditUpdate = creditUpdateRows[0]!;

		// Batch independent inserts in parallel to reduce lock hold time
		await Promise.all([
			// Credit entry for destination
			tx.raw(
				`INSERT INTO entry_record (transaction_id, account_id, entry_type, amount, currency, balance_before, balance_after, account_lock_version, is_hot_account)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
				[
					txnRecord.id,
					destAccount.id,
					"CREDIT",
					amount,
					acctCurrency,
					creditUpdate.balance_before,
					creditUpdate.balance_after,
					creditUpdate.lock_version,
					false,
				],
			),
			// Debit entry for system account (marked as hot)
			tx.raw(
				`INSERT INTO entry_record (transaction_id, system_account_id, entry_type, amount, currency, is_hot_account)
         VALUES ($1, $2, $3, $4, $5, $6)`,
				[txnRecord.id, sourceSystemId, "DEBIT", amount, acctCurrency, true],
			),
			// DEBIT source system account (hot account pattern)
			tx.raw(
				`INSERT INTO hot_account_entry (account_id, amount, entry_type, transaction_id, status)
         VALUES ($1, $2, $3, $4, $5)`,
				[sourceSystemId, -amount, "DEBIT", txnRecord.id, "pending"],
			),
			// Outbox for async notification
			tx.raw(
				`INSERT INTO outbox (topic, payload)
         VALUES ($1, $2)`,
				[
					"ledger-account-credited",
					JSON.stringify({
						accountId: destAccount.id,
						holderId,
						holderType: destAccount.holder_type,
						amount,
						transactionId: txnRecord.id,
						reference,
						category,
					}),
				],
			),
			// Event store
			appendEvent(tx, {
				aggregateType: AGGREGATE_TYPES.TRANSACTION,
				aggregateId: txnRecord.id,
				eventType: TRANSACTION_EVENTS.POSTED,
				eventData: {
					reference,
					amount,
					source: sourceSystemAccount,
					destination: holderId,
					category,
				},
				correlationId,
			}),
			// Log transaction for velocity tracking
			logTransactionInTx(tx, {
				accountId: destAccount.id,
				ledgerTxnId: txnRecord.id,
				txnType: "credit",
				amount,
				category,
				reference,
			}),
			// Save idempotency key
			params.idempotencyKey
				? saveIdempotencyKeyInTx(tx, {
						key: params.idempotencyKey,
						reference,
						resultData: rawToTransactionResponse(txnRecord, "credit", acctCurrency),
					})
				: Promise.resolve(),
		]);

		return rawToTransactionResponse(txnRecord, "credit", acctCurrency);
	});

	await runAfterTransactionHooks(ctx, hookParams);
	return result;
}

// =============================================================================
// DEBIT ACCOUNT
// =============================================================================

export async function debitAccount(
	ctx: SummaContext,
	params: {
		holderId: string;
		amount: number;
		reference: string;
		description?: string;
		category?: string;
		metadata?: Record<string, unknown>;
		destinationSystemAccount?: string;
		allowOverdraft?: boolean;
		idempotencyKey?: string;
	},
): Promise<LedgerTransaction> {
	const {
		holderId,
		amount,
		reference,
		description = "",
		category = "debit",
		metadata = {},
		destinationSystemAccount = ctx.options.systemAccounts.world ?? "@World",
		allowOverdraft = false,
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

	const hookParams = { type: "debit" as const, amount, reference, holderId, category, ctx };
	await runBeforeTransactionHooks(ctx, hookParams);

	const result = await withTransactionTimeout(ctx, async (tx) => {
		const idem = await checkIdempotencyKeyInTx(tx, {
			idempotencyKey: params.idempotencyKey,
			reference,
		});
		if (idem.alreadyProcessed) {
			return idem.cachedResult as LedgerTransaction;
		}

		// Get source account (FOR UPDATE to prevent stale balance reads)
		const sourceAccount = await resolveAccountForUpdate(tx, holderId);
		if (sourceAccount.status !== "active") {
			if (sourceAccount.status === "frozen") throw SummaError.accountFrozen();
			if (sourceAccount.status === "closed") throw SummaError.accountClosed();
			throw SummaError.conflict(`Account is ${sourceAccount.status}`);
		}

		// Limit enforcement inside tx
		await enforceLimitsWithAccountId(ctx, {
			accountId: sourceAccount.id,
			holderId,
			amount,
			txnType: "debit",
			category,
		});

		// Check sufficient balance
		const availableBalance = Number(sourceAccount.balance) - Number(sourceAccount.pending_debit);
		if (!allowOverdraft && !sourceAccount.allow_overdraft && availableBalance < amount) {
			throw SummaError.insufficientBalance("Insufficient balance for this transaction");
		}

		// Get destination system account
		const destSystemRows = await tx.raw<{ id: string }>(
			`SELECT id FROM system_account WHERE identifier = $1 LIMIT 1`,
			[destinationSystemAccount],
		);
		if (!destSystemRows[0]) {
			throw SummaError.notFound(`System account not found: ${destinationSystemAccount}`);
		}
		const destSystemId = destSystemRows[0].id;

		const acctCurrency = sourceAccount.currency;
		const correlationId = randomUUID();

		// Create transaction record
		const txnRecordRows = await tx.raw<RawTransactionRow>(
			`INSERT INTO transaction_record (reference, status, amount, currency, description, source_account_id, destination_system_account_id, correlation_id, meta_data, posted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
       RETURNING *`,
			[
				reference,
				"posted",
				amount,
				acctCurrency,
				description,
				sourceAccount.id,
				destSystemId,
				correlationId,
				JSON.stringify({ ...metadata, category }),
			],
		);
		const txnRecord = txnRecordRows[0]!;

		// DEBIT source account (atomic)
		const debitUpdateRows = await tx.raw<RawBalanceUpdateRow>(
			`UPDATE account_balance
       SET balance = balance - $1,
           debit_balance = debit_balance + $1,
           lock_version = lock_version + 1,
           updated_at = NOW()
       WHERE id = $2
       RETURNING balance + $1 as balance_before, balance as balance_after, lock_version`,
			[amount, sourceAccount.id],
		);
		const debitUpdate = debitUpdateRows[0]!;

		// Batch independent inserts in parallel
		await Promise.all([
			tx.raw(
				`INSERT INTO entry_record (transaction_id, account_id, entry_type, amount, currency, balance_before, balance_after, account_lock_version, is_hot_account)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
				[
					txnRecord.id,
					sourceAccount.id,
					"DEBIT",
					amount,
					acctCurrency,
					debitUpdate.balance_before,
					debitUpdate.balance_after,
					debitUpdate.lock_version,
					false,
				],
			),
			tx.raw(
				`INSERT INTO entry_record (transaction_id, system_account_id, entry_type, amount, currency, is_hot_account)
         VALUES ($1, $2, $3, $4, $5, $6)`,
				[txnRecord.id, destSystemId, "CREDIT", amount, acctCurrency, true],
			),
			tx.raw(
				`INSERT INTO hot_account_entry (account_id, amount, entry_type, transaction_id, status)
         VALUES ($1, $2, $3, $4, $5)`,
				[destSystemId, amount, "CREDIT", txnRecord.id, "pending"],
			),
			tx.raw(
				`INSERT INTO outbox (topic, payload)
         VALUES ($1, $2)`,
				[
					"ledger-account-debited",
					JSON.stringify({
						accountId: sourceAccount.id,
						holderId,
						holderType: sourceAccount.holder_type,
						amount,
						transactionId: txnRecord.id,
						reference,
						category,
					}),
				],
			),
			appendEvent(tx, {
				aggregateType: AGGREGATE_TYPES.TRANSACTION,
				aggregateId: txnRecord.id,
				eventType: TRANSACTION_EVENTS.POSTED,
				eventData: {
					reference,
					amount,
					source: holderId,
					destination: destinationSystemAccount,
					category,
				},
				correlationId,
			}),
			logTransactionInTx(tx, {
				accountId: sourceAccount.id,
				ledgerTxnId: txnRecord.id,
				txnType: "debit",
				amount,
				category,
				reference,
			}),
			params.idempotencyKey
				? saveIdempotencyKeyInTx(tx, {
						key: params.idempotencyKey,
						reference,
						resultData: rawToTransactionResponse(txnRecord, "debit", acctCurrency),
					})
				: Promise.resolve(),
		]);

		return rawToTransactionResponse(txnRecord, "debit", acctCurrency);
	});

	await runAfterTransactionHooks(ctx, hookParams);
	return result;
}

// =============================================================================
// TRANSFER (account to account)
// =============================================================================

export async function transfer(
	ctx: SummaContext,
	params: {
		sourceHolderId: string;
		destinationHolderId: string;
		amount: number;
		reference: string;
		description?: string;
		category?: string;
		metadata?: Record<string, unknown>;
		idempotencyKey?: string;
	},
): Promise<LedgerTransaction> {
	const {
		sourceHolderId,
		destinationHolderId,
		amount,
		reference,
		description = "",
		category = "transfer",
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

	if (sourceHolderId === destinationHolderId) {
		throw SummaError.invalidArgument("Cannot transfer to the same account");
	}

	const hookParams = {
		type: "transfer" as const,
		amount,
		reference,
		sourceHolderId,
		destinationHolderId,
		category,
		ctx,
	};
	await runBeforeTransactionHooks(ctx, hookParams);

	const result = await withTransactionTimeout(ctx, async (tx) => {
		const idem = await checkIdempotencyKeyInTx(tx, {
			idempotencyKey: params.idempotencyKey,
			reference,
		});
		if (idem.alreadyProcessed) {
			return idem.cachedResult as LedgerTransaction;
		}

		// Look up both accounts without lock first, then lock in sorted ID order
		// to prevent deadlocks when concurrent transfers go A->B and B->A.
		const lookupRows = await tx.raw<Pick<RawAccountRow, "id" | "holder_id">>(
			`SELECT id, holder_id FROM account_balance
       WHERE holder_id IN ($1, $2)`,
			[sourceHolderId, destinationHolderId],
		);

		const srcPreview = lookupRows.find((r) => r.holder_id === sourceHolderId);
		const destPreview = lookupRows.find((r) => r.holder_id === destinationHolderId);

		if (!srcPreview) throw SummaError.notFound("Source account not found");
		if (!destPreview) throw SummaError.notFound("Destination account not found");

		// Lock both in deterministic ID order to prevent deadlocks.
		const [firstId, secondId] = [srcPreview.id, destPreview.id].sort();
		const firstRows = await tx.raw<RawAccountRow>(
			`SELECT * FROM account_balance WHERE id = $1 FOR UPDATE`,
			[firstId],
		);
		const secondRows = await tx.raw<RawAccountRow>(
			`SELECT * FROM account_balance WHERE id = $1 FOR UPDATE`,
			[secondId],
		);

		const firstRow = firstRows[0];
		const secondRow = secondRows[0];

		const source = firstRow?.id === srcPreview.id ? firstRow : secondRow;
		const dest = firstRow?.id === destPreview.id ? firstRow : secondRow;

		if (!source) throw SummaError.notFound("Source account not found");
		if (!dest) throw SummaError.notFound("Destination account not found");
		if (source.status !== "active") {
			if (source.status === "frozen") throw SummaError.accountFrozen("Source account is frozen");
			if (source.status === "closed") throw SummaError.accountClosed("Source account is closed");
			throw SummaError.conflict(`Source account is ${source.status}`);
		}
		if (dest.status !== "active") {
			if (dest.status === "frozen") throw SummaError.accountFrozen("Destination account is frozen");
			if (dest.status === "closed") throw SummaError.accountClosed("Destination account is closed");
			throw SummaError.conflict(`Destination account is ${dest.status}`);
		}

		// Check sufficient balance first (cheap) before limit queries (expensive)
		const availableBalance = Number(source.balance) - Number(source.pending_debit);
		if (!source.allow_overdraft && availableBalance < amount) {
			throw SummaError.insufficientBalance("Insufficient balance for this transaction");
		}

		// Enforce velocity limits inside tx
		await enforceLimitsWithAccountId(ctx, {
			accountId: source.id,
			holderId: sourceHolderId,
			amount,
			txnType: "debit",
			category,
		});

		const srcCurrency = source.currency;
		const destCurrency = dest.currency;

		if (srcCurrency !== destCurrency) {
			throw SummaError.invalidArgument(
				`Currency mismatch: source is ${srcCurrency}, destination is ${destCurrency}`,
			);
		}

		const correlationId = randomUUID();

		// Create transaction record
		const txnRecordRows = await tx.raw<RawTransactionRow>(
			`INSERT INTO transaction_record (reference, status, amount, currency, description, source_account_id, destination_account_id, correlation_id, meta_data, posted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
       RETURNING *`,
			[
				reference,
				"posted",
				amount,
				srcCurrency,
				description,
				source.id,
				dest.id,
				correlationId,
				JSON.stringify({ ...metadata, category }),
			],
		);
		const txnRecord = txnRecordRows[0]!;

		// DEBIT source + CREDIT destination in parallel (both rows already locked)
		const [debitRows, creditRows] = await Promise.all([
			tx.raw<RawBalanceUpdateRow>(
				`UPDATE account_balance
         SET balance = balance - $1,
             debit_balance = debit_balance + $1,
             lock_version = lock_version + 1,
             updated_at = NOW()
         WHERE id = $2
         RETURNING balance + $1 as balance_before, balance as balance_after, lock_version`,
				[amount, source.id],
			),
			tx.raw<RawBalanceUpdateRow>(
				`UPDATE account_balance
         SET balance = balance + $1,
             credit_balance = credit_balance + $1,
             lock_version = lock_version + 1,
             updated_at = NOW()
         WHERE id = $2
         RETURNING balance - $1 as balance_before, balance as balance_after, lock_version`,
				[amount, dest.id],
			),
		]);
		const debitUpdate = debitRows[0]!;
		const creditUpdate = creditRows[0]!;

		// Batch all independent inserts in parallel
		await Promise.all([
			tx.raw(
				`INSERT INTO entry_record (transaction_id, account_id, entry_type, amount, currency, balance_before, balance_after, account_lock_version, is_hot_account)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
				[
					txnRecord.id,
					source.id,
					"DEBIT",
					amount,
					srcCurrency,
					debitUpdate.balance_before,
					debitUpdate.balance_after,
					debitUpdate.lock_version,
					false,
				],
			),
			tx.raw(
				`INSERT INTO entry_record (transaction_id, account_id, entry_type, amount, currency, balance_before, balance_after, account_lock_version, is_hot_account)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
				[
					txnRecord.id,
					dest.id,
					"CREDIT",
					amount,
					destCurrency,
					creditUpdate.balance_before,
					creditUpdate.balance_after,
					creditUpdate.lock_version,
					false,
				],
			),
			tx.raw(`INSERT INTO outbox (topic, payload) VALUES ($1, $2)`, [
				"ledger-account-debited",
				JSON.stringify({
					accountId: source.id,
					holderId: sourceHolderId,
					holderType: source.holder_type,
					amount,
					transactionId: txnRecord.id,
					reference,
					category,
					type: "transfer",
				}),
			]),
			tx.raw(`INSERT INTO outbox (topic, payload) VALUES ($1, $2)`, [
				"ledger-account-credited",
				JSON.stringify({
					accountId: dest.id,
					holderId: destinationHolderId,
					holderType: dest.holder_type,
					amount,
					transactionId: txnRecord.id,
					reference,
					category,
					type: "transfer",
				}),
			]),
			appendEvent(tx, {
				aggregateType: AGGREGATE_TYPES.TRANSACTION,
				aggregateId: txnRecord.id,
				eventType: TRANSACTION_EVENTS.POSTED,
				eventData: {
					reference,
					amount,
					source: sourceHolderId,
					destination: destinationHolderId,
					category,
				},
				correlationId,
			}),
			logTransactionInTx(tx, {
				accountId: source.id,
				ledgerTxnId: txnRecord.id,
				txnType: "debit",
				amount,
				category,
				reference,
			}),
			logTransactionInTx(tx, {
				accountId: dest.id,
				ledgerTxnId: txnRecord.id,
				txnType: "credit",
				amount,
				category,
				reference,
			}),
			params.idempotencyKey
				? saveIdempotencyKeyInTx(tx, {
						key: params.idempotencyKey,
						reference,
						resultData: rawToTransactionResponse(txnRecord, "transfer", srcCurrency),
					})
				: Promise.resolve(),
		]);

		return rawToTransactionResponse(txnRecord, "transfer", srcCurrency);
	});

	await runAfterTransactionHooks(ctx, hookParams);
	return result;
}

// =============================================================================
// MULTI-DESTINATION TRANSFER
// =============================================================================

export async function multiTransfer(
	ctx: SummaContext,
	params: {
		sourceHolderId: string;
		amount: number;
		destinations: HoldDestination[];
		reference: string;
		description?: string;
		category?: string;
		metadata?: Record<string, unknown>;
		idempotencyKey?: string;
	},
): Promise<LedgerTransaction> {
	const {
		sourceHolderId,
		amount,
		destinations,
		reference,
		description = "",
		category = "transfer",
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

	const hookParams = {
		type: "transfer" as const,
		amount,
		reference,
		sourceHolderId,
		category,
		ctx,
	};
	await runBeforeTransactionHooks(ctx, hookParams);

	const result = await withTransactionTimeout(ctx, async (tx) => {
		const idem = await checkIdempotencyKeyInTx(tx, {
			idempotencyKey: params.idempotencyKey,
			reference,
		});
		if (idem.alreadyProcessed) {
			return idem.cachedResult as LedgerTransaction;
		}

		// Lock source account
		const source = await resolveAccountForUpdate(tx, sourceHolderId);
		if (source.status !== "active") {
			if (source.status === "frozen") throw SummaError.accountFrozen();
			if (source.status === "closed") throw SummaError.accountClosed();
			throw SummaError.conflict(`Source account is ${source.status}`);
		}

		// Check sufficient balance
		const availableBalance = Number(source.balance) - Number(source.pending_debit);
		if (!source.allow_overdraft && availableBalance < amount) {
			throw SummaError.insufficientBalance("Insufficient balance for this transaction");
		}

		// Enforce velocity limits on source
		await enforceLimitsWithAccountId(ctx, {
			accountId: source.id,
			holderId: sourceHolderId,
			amount,
			txnType: "debit",
			category,
		});

		const acctCurrency = source.currency;
		const correlationId = randomUUID();

		// Create transaction record
		const txnRecordRows = await tx.raw<RawTransactionRow>(
			`INSERT INTO transaction_record (reference, status, amount, currency, description, source_account_id, correlation_id, meta_data, posted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       RETURNING *`,
			[
				reference,
				"posted",
				amount,
				acctCurrency,
				description,
				source.id,
				correlationId,
				JSON.stringify({ ...metadata, category, destinations }),
			],
		);
		const txnRecord = txnRecordRows[0]!;

		// DEBIT source account atomically
		const debitUpdateRows = await tx.raw<RawBalanceUpdateRow>(
			`UPDATE account_balance
       SET balance = balance - $1,
           debit_balance = debit_balance + $1,
           lock_version = lock_version + 1,
           updated_at = NOW()
       WHERE id = $2
       RETURNING balance + $1 as balance_before, balance as balance_after, lock_version`,
			[amount, source.id],
		);
		const debitUpdate = debitUpdateRows[0]!;

		// DEBIT entry record for source
		await tx.raw(
			`INSERT INTO entry_record (transaction_id, account_id, entry_type, amount, currency, balance_before, balance_after, account_lock_version, is_hot_account)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
			[
				txnRecord.id,
				source.id,
				"DEBIT",
				amount,
				acctCurrency,
				debitUpdate.balance_before,
				debitUpdate.balance_after,
				debitUpdate.lock_version,
				false,
			],
		);

		// Credit all destinations
		const destResults = await creditMultiDestinations(tx, ctx, {
			transactionId: txnRecord.id,
			currency: acctCurrency,
			totalAmount: amount,
			destinations,
		});

		// Batch outbox + event store + transaction logs
		const outboxInserts: Promise<unknown>[] = [
			tx.raw(`INSERT INTO outbox (topic, payload) VALUES ($1, $2)`, [
				"ledger-account-debited",
				JSON.stringify({
					accountId: source.id,
					holderId: sourceHolderId,
					holderType: source.holder_type,
					amount,
					transactionId: txnRecord.id,
					reference,
					category,
					type: "multi-transfer",
				}),
			]),
		];

		for (const dest of destResults) {
			if (dest.accountId && dest.holderId) {
				outboxInserts.push(
					tx.raw(`INSERT INTO outbox (topic, payload) VALUES ($1, $2)`, [
						"ledger-account-credited",
						JSON.stringify({
							accountId: dest.accountId,
							holderId: dest.holderId,
							amount: dest.amount,
							transactionId: txnRecord.id,
							reference,
							category,
							type: "multi-transfer",
						}),
					]),
				);
			}
		}

		const logInserts: Promise<unknown>[] = [
			logTransactionInTx(tx, {
				accountId: source.id,
				ledgerTxnId: txnRecord.id,
				txnType: "debit",
				amount,
				category,
				reference,
			}),
		];
		for (const dest of destResults) {
			if (dest.accountId) {
				logInserts.push(
					logTransactionInTx(tx, {
						accountId: dest.accountId,
						ledgerTxnId: txnRecord.id,
						txnType: "credit",
						amount: dest.amount,
						category,
						reference,
					}),
				);
			}
		}

		await Promise.all([
			...outboxInserts,
			...logInserts,
			appendEvent(tx, {
				aggregateType: AGGREGATE_TYPES.TRANSACTION,
				aggregateId: txnRecord.id,
				eventType: TRANSACTION_EVENTS.POSTED,
				eventData: {
					reference,
					amount,
					source: sourceHolderId,
					destinations: destinations.map((d) => d.holderId ?? d.systemAccount),
					category,
				},
				correlationId,
			}),
			params.idempotencyKey
				? saveIdempotencyKeyInTx(tx, {
						key: params.idempotencyKey,
						reference,
						resultData: rawToTransactionResponse(txnRecord, "transfer", acctCurrency),
					})
				: Promise.resolve(),
		]);

		return rawToTransactionResponse(txnRecord, "transfer", acctCurrency);
	});

	await runAfterTransactionHooks(ctx, hookParams);
	return result;
}

// =============================================================================
// GET / LIST TRANSACTIONS
// =============================================================================

export async function getTransaction(
	ctx: SummaContext,
	transactionId: string,
): Promise<LedgerTransaction> {
	const rows = await ctx.adapter.raw<RawTransactionRow>(
		`SELECT * FROM transaction_record WHERE id = $1 LIMIT 1`,
		[transactionId],
	);

	const txn = rows[0];
	if (!txn) throw SummaError.notFound("Transaction not found");

	const hasDestinations = !!(txn.meta_data as Record<string, unknown> | null)?.destinations;
	const type: TransactionType =
		txn.source_account_id && txn.destination_account_id
			? "transfer"
			: txn.source_account_id && hasDestinations
				? "transfer"
				: txn.source_account_id
					? "debit"
					: "credit";

	return rawToTransactionResponse(txn, type, txn.currency);
}

export async function listAccountTransactions(
	ctx: SummaContext,
	params: {
		holderId: string;
		page?: number;
		perPage?: number;
		status?: TransactionStatus;
		category?: string;
		sortBy?: string;
		type?: TransactionType;
		dateFrom?: string;
		dateTo?: string;
		amountMin?: number;
		amountMax?: number;
	},
): Promise<{
	transactions: LedgerTransaction[];
	hasMore: boolean;
	total?: number;
}> {
	const page = Math.max(1, params.page ?? 1);
	const perPage = Math.min(params.perPage ?? 20, 100);
	const offset = (page - 1) * perPage;

	// First find the account
	const accountRows = await ctx.adapter.raw<{ id: string }>(
		`SELECT id FROM account_balance WHERE holder_id = $1 LIMIT 1`,
		[params.holderId],
	);

	if (!accountRows[0]) throw SummaError.notFound("Account not found");
	const accountId = accountRows[0].id;

	// Build common filter SQL fragments
	const filterParts: string[] = [];
	const filterParams: unknown[] = [];
	let pIdx = 1;

	// We'll use $1 as accountId in all branches
	filterParams.push(accountId);
	pIdx++;

	if (params.status) {
		filterParts.push(`AND status = $${pIdx++}`);
		filterParams.push(params.status);
	}
	if (params.category) {
		filterParts.push(`AND meta_data->>'category' = $${pIdx++}`);
		filterParams.push(params.category);
	}
	if (params.dateFrom) {
		filterParts.push(`AND created_at >= $${pIdx++}::timestamptz`);
		filterParams.push(params.dateFrom);
	}
	if (params.dateTo) {
		filterParts.push(`AND created_at <= $${pIdx++}::timestamptz`);
		filterParams.push(params.dateTo);
	}
	if (params.amountMin != null) {
		filterParts.push(`AND amount >= $${pIdx++}`);
		filterParams.push(params.amountMin);
	}
	if (params.amountMax != null) {
		filterParts.push(`AND amount <= $${pIdx++}`);
		filterParams.push(params.amountMax);
	}

	const commonFilters = filterParts.join(" ");
	const orderCol = params.sortBy === "amount" ? "amount DESC" : "created_at DESC";

	// Build UNION ALL query based on type filter
	let unionQuery: string;
	if (params.type === "credit") {
		unionQuery = `
      SELECT * FROM transaction_record
      WHERE destination_account_id = $1
        AND (source_account_id IS NULL OR source_account_id != $1)
        ${commonFilters}
      UNION ALL
      SELECT tr.* FROM transaction_record tr
      JOIN entry_record er ON er.transaction_id = tr.id
      WHERE er.account_id = $1
        AND er.entry_type = 'CREDIT'
        AND tr.source_account_id IS NOT NULL
        AND tr.destination_account_id IS NULL
        AND tr.source_account_id != $1
        ${commonFilters}
    `;
	} else if (params.type === "debit") {
		unionQuery = `
      SELECT * FROM transaction_record
      WHERE source_account_id = $1 ${commonFilters}
    `;
	} else if (params.type === "transfer") {
		unionQuery = `
      SELECT * FROM transaction_record
      WHERE source_account_id = $1
        AND destination_account_id IS NOT NULL
        ${commonFilters}
      UNION ALL
      SELECT * FROM transaction_record
      WHERE destination_account_id = $1
        AND source_account_id IS NOT NULL
        AND source_account_id != $1
        ${commonFilters}
    `;
	} else {
		unionQuery = `
      SELECT * FROM transaction_record
      WHERE source_account_id = $1 ${commonFilters}
      UNION ALL
      SELECT * FROM transaction_record
      WHERE destination_account_id = $1
        AND (source_account_id IS NULL OR source_account_id != $1)
        ${commonFilters}
      UNION ALL
      SELECT tr.* FROM transaction_record tr
      JOIN entry_record er ON er.transaction_id = tr.id
      WHERE er.account_id = $1
        AND er.entry_type = 'CREDIT'
        AND tr.source_account_id IS NOT NULL
        AND tr.destination_account_id IS NULL
        AND tr.source_account_id != $1
        ${commonFilters}
    `;
	}

	// Add limit/offset params
	filterParams.push(perPage + 1);
	filterParams.push(offset);

	const rows = await ctx.adapter.raw<RawTransactionRow & { total_count: number }>(
		`SELECT *, COUNT(*) OVER()::int AS total_count FROM (
       ${unionQuery}
     ) combined
     ORDER BY ${orderCol}
     LIMIT $${pIdx++}
     OFFSET $${pIdx}`,
		filterParams,
	);

	const total = rows.length > 0 ? Number(rows[0]?.total_count) : 0;
	const hasMore = rows.length > perPage;
	const data = (hasMore ? rows.slice(0, perPage) : rows).map((txn) => {
		const hasDestinations = !!(txn.meta_data as Record<string, unknown> | null)?.destinations;
		const type: TransactionType =
			txn.source_account_id && txn.destination_account_id
				? "transfer"
				: txn.source_account_id && hasDestinations
					? "transfer"
					: txn.source_account_id === accountId
						? "debit"
						: "credit";
		return rawToTransactionResponse(txn, type, txn.currency);
	});

	return { transactions: data, hasMore, total };
}

// =============================================================================
// REFUND TRANSACTION
// =============================================================================

export async function refundTransaction(
	ctx: SummaContext,
	params: {
		transactionId: string;
		reason: string;
		amount?: number;
		idempotencyKey?: string;
	},
): Promise<LedgerTransaction> {
	const { transactionId, reason, amount: refundAmount } = params;

	const result = await withTransactionTimeout(ctx, async (tx) => {
		// Lock original transaction row to prevent concurrent refunds
		const originalRows = await tx.raw<RawTransactionRow>(
			`SELECT * FROM transaction_record WHERE id = $1 FOR UPDATE`,
			[transactionId],
		);

		const original = originalRows[0];
		if (!original) throw SummaError.notFound("Transaction not found");
		if (original.status !== "posted") {
			throw SummaError.conflict(`Cannot refund transaction in status: ${original.status}`);
		}

		const originalAmount = Number(original.amount);
		const alreadyRefunded = Number(original.refunded_amount ?? 0);
		const actualRefundAmount = refundAmount ?? originalAmount - alreadyRefunded;

		if (actualRefundAmount <= 0) {
			throw SummaError.invalidArgument("Refund amount must be positive");
		}
		if (alreadyRefunded + actualRefundAmount > originalAmount) {
			throw SummaError.invalidArgument("Refund amount exceeds remaining refundable amount");
		}

		// Deterministic refund reference
		const refundReference = refundAmount
			? `refund_${original.reference}_p${alreadyRefunded + actualRefundAmount}`
			: `refund_${original.reference}`;

		// Idempotency check INSIDE transaction
		const idem = await checkIdempotencyKeyInTx(tx, {
			idempotencyKey: params.idempotencyKey,
			reference: refundReference,
		});
		if (idem.alreadyProcessed) {
			return idem.cachedResult as LedgerTransaction;
		}

		const correlationId = randomUUID();

		// Update refunded_amount on original
		const newRefundedAmount = alreadyRefunded + actualRefundAmount;
		const newStatus = newRefundedAmount >= originalAmount ? "reversed" : "posted";
		await tx.raw(
			`UPDATE transaction_record
       SET refunded_amount = $1, status = $2
       WHERE id = $3`,
			[newRefundedAmount, newStatus, transactionId],
		);

		// Create reversal transaction record
		const reversalRows = await tx.raw<RawTransactionRow>(
			`INSERT INTO transaction_record (reference, status, amount, currency, description, source_account_id, destination_account_id, source_system_account_id, destination_system_account_id, parent_id, is_reversal, correlation_id, meta_data, posted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
       RETURNING *`,
			[
				refundReference,
				"posted",
				actualRefundAmount,
				original.currency,
				`Refund: ${reason}`,
				original.destination_account_id,
				original.source_account_id,
				original.destination_system_account_id,
				original.source_system_account_id,
				original.id,
				true,
				correlationId,
				JSON.stringify({ reason, originalTransactionId: transactionId }),
			],
		);
		const reversal = reversalRows[0]!;

		// Reverse entries for user accounts
		if (original.destination_account_id) {
			const debitUpdateRows = await tx.raw<RawBalanceUpdateRow>(
				`UPDATE account_balance
         SET balance = balance - $1,
             debit_balance = debit_balance + $1,
             lock_version = lock_version + 1,
             updated_at = NOW()
         WHERE id = $2
         RETURNING balance + $1 as balance_before, balance as balance_after, lock_version`,
				[actualRefundAmount, original.destination_account_id],
			);
			const debitUpdate = debitUpdateRows[0]!;

			await tx.raw(
				`INSERT INTO entry_record (transaction_id, account_id, entry_type, amount, currency, balance_before, balance_after, account_lock_version, is_hot_account)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
				[
					reversal.id,
					original.destination_account_id,
					"DEBIT",
					actualRefundAmount,
					original.currency,
					debitUpdate.balance_before,
					debitUpdate.balance_after,
					debitUpdate.lock_version,
					false,
				],
			);
		}

		if (original.source_account_id) {
			const creditUpdateRows = await tx.raw<RawBalanceUpdateRow>(
				`UPDATE account_balance
         SET balance = balance + $1,
             credit_balance = credit_balance + $1,
             lock_version = lock_version + 1,
             updated_at = NOW()
         WHERE id = $2
         RETURNING balance - $1 as balance_before, balance as balance_after, lock_version`,
				[actualRefundAmount, original.source_account_id],
			);
			const creditUpdate = creditUpdateRows[0]!;

			await tx.raw(
				`INSERT INTO entry_record (transaction_id, account_id, entry_type, amount, currency, balance_before, balance_after, account_lock_version, is_hot_account)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
				[
					reversal.id,
					original.source_account_id,
					"CREDIT",
					actualRefundAmount,
					original.currency,
					creditUpdate.balance_before,
					creditUpdate.balance_after,
					creditUpdate.lock_version,
					false,
				],
			);
		}

		// Reverse system account entries via hot account pattern
		if (original.source_system_account_id) {
			await tx.raw(
				`INSERT INTO hot_account_entry (account_id, amount, entry_type, transaction_id, status)
         VALUES ($1, $2, $3, $4, $5)`,
				[original.source_system_account_id, actualRefundAmount, "CREDIT", reversal.id, "pending"],
			);
			await tx.raw(
				`INSERT INTO entry_record (transaction_id, system_account_id, entry_type, amount, currency, is_hot_account)
         VALUES ($1, $2, $3, $4, $5, $6)`,
				[
					reversal.id,
					original.source_system_account_id,
					"CREDIT",
					actualRefundAmount,
					original.currency,
					true,
				],
			);
		}

		if (original.destination_system_account_id) {
			await tx.raw(
				`INSERT INTO hot_account_entry (account_id, amount, entry_type, transaction_id, status)
         VALUES ($1, $2, $3, $4, $5)`,
				[
					original.destination_system_account_id,
					-actualRefundAmount,
					"DEBIT",
					reversal.id,
					"pending",
				],
			);
			await tx.raw(
				`INSERT INTO entry_record (transaction_id, system_account_id, entry_type, amount, currency, is_hot_account)
         VALUES ($1, $2, $3, $4, $5, $6)`,
				[
					reversal.id,
					original.destination_system_account_id,
					"DEBIT",
					actualRefundAmount,
					original.currency,
					true,
				],
			);
		}

		// Event store
		await appendEvent(tx, {
			aggregateType: AGGREGATE_TYPES.TRANSACTION,
			aggregateId: original.id,
			eventType: TRANSACTION_EVENTS.REVERSED,
			eventData: {
				reversalId: reversal.id,
				reason,
				amount: actualRefundAmount,
				refundedSoFar: newRefundedAmount,
				fullyRefunded: newStatus === "reversed",
			},
			correlationId,
		});

		// Outbox for async notification of refund
		if (original.destination_account_id) {
			await tx.raw(`INSERT INTO outbox (topic, payload) VALUES ($1, $2)`, [
				"ledger-account-debited",
				JSON.stringify({
					accountId: original.destination_account_id,
					amount: actualRefundAmount,
					transactionId: reversal.id,
					reference: reversal.reference,
					category: "refund",
					type: "refund",
				}),
			]);
		}
		if (original.source_account_id) {
			await tx.raw(`INSERT INTO outbox (topic, payload) VALUES ($1, $2)`, [
				"ledger-account-credited",
				JSON.stringify({
					accountId: original.source_account_id,
					amount: actualRefundAmount,
					transactionId: reversal.id,
					reference: reversal.reference,
					category: "refund",
					type: "refund",
				}),
			]);
		}

		// Log refund for velocity tracking
		if (original.destination_account_id) {
			await logTransactionInTx(tx, {
				accountId: original.destination_account_id,
				ledgerTxnId: reversal.id,
				txnType: "debit",
				amount: actualRefundAmount,
				category: "refund",
				reference: reversal.reference,
			});
		}
		if (original.source_account_id) {
			await logTransactionInTx(tx, {
				accountId: original.source_account_id,
				ledgerTxnId: reversal.id,
				txnType: "credit",
				amount: actualRefundAmount,
				category: "refund",
				reference: reversal.reference,
			});
		}

		const response = rawToTransactionResponse(reversal, "credit", original.currency);

		// Save idempotency key inside transaction for atomicity
		if (params.idempotencyKey) {
			await saveIdempotencyKeyInTx(tx, {
				key: params.idempotencyKey,
				reference: refundReference,
				resultData: response,
			});
		}

		return response;
	});

	return result;
}

// =============================================================================
// HELPERS
// =============================================================================

function rawToTransactionResponse(
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
