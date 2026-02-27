// =============================================================================
// TRANSACTION MANAGER -- Double-entry transaction operations
// =============================================================================
// Every transaction creates balanced debit + credit entry records.
// System accounts use hot account pattern (entry INSERT without balance update).
//
// v2 changes:
// - transaction_record → transfer (status is a column, no separate table)
// - account has mutable balance (no LATERAL JOIN, no account_balance_version)
// - entries ARE events (no separate ledger_event)
// - unified account model (no system_account_id FKs)
// - velocity tracking via entry table (no account_transaction_log)

import { randomUUID } from "node:crypto";
import type {
	HoldDestination,
	LedgerTransaction,
	SummaContext,
	TransactionStatus,
	TransactionType,
} from "@summa-ledger/core";
import { decodeCursor, encodeCursor, SummaError } from "@summa-ledger/core";
import { createTableResolver } from "@summa-ledger/core/db";
import {
	runAfterOperationHooks,
	runAfterTransactionHooks,
	runBeforeTransactionHooks,
} from "../context/hooks.js";
import { withTransactionTimeout } from "../infrastructure/event-store.js";
import type { TransactionBatchEngine } from "../plugins/batch-engine.js";
import { resolveAccountForUpdate } from "./account-manager.js";
import { checkSufficientBalance } from "./balance-check.js";
import { insertEntryAndUpdateBalance } from "./entry-balance.js";
import { checkIdempotencyKeyInTx, isValidCachedResult } from "./idempotency.js";
import { getLedgerId } from "./ledger-helpers.js";
import { enforceLimitsWithAccountId } from "./limit-manager.js";
import { executeMegaCTE } from "./mega-cte.js";
import { creditMultiDestinations } from "./multi-dest-credit.js";
import type { RawAccountRow, RawTransferRow } from "./raw-types.js";
import { rawToTransactionResponse, transferSelectSql } from "./sql-helpers.js";
import {
	assertAccountActive,
	batchTransactionSideEffects,
	resolveSystemAccountInTx,
	validateAmount,
} from "./transaction-helpers.js";

// =============================================================================
// PREV HASH LOOKUP
// =============================================================================

/** Look up the latest entry hash for an account's chain. */
async function getPrevHash(
	tx: { raw: <T>(sql: string, params: unknown[]) => Promise<T[]> },
	t: (name: string) => string,
	accountId: string,
): Promise<string | null> {
	const rows = await tx.raw<{ hash: string }>(
		`SELECT hash FROM ${t("entry")} WHERE account_id = $1 ORDER BY sequence_number DESC LIMIT 1`,
		[accountId],
	);
	return rows[0]?.hash ?? null;
}

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
		effectiveDate?: Date | string;
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

	validateAmount(amount, ctx.options.advanced.maxTransactionAmount);
	const ledgerId = getLedgerId(ctx);

	// --- Batching fast path ---
	const batchEngine = (ctx as SummaContext & { batchEngine?: TransactionBatchEngine }).batchEngine;
	if (ctx.options.advanced.enableBatching && batchEngine) {
		return batchEngine.submit({
			type: "credit",
			holderId,
			amount,
			reference,
			description,
			category,
			metadata,
			systemAccount: sourceSystemAccount,
			allowOverdraft: false,
			idempotencyKey: params.idempotencyKey,
		});
	}

	const hookParams = { type: "credit" as const, amount, reference, holderId, category, ctx };
	await runBeforeTransactionHooks(ctx, hookParams);

	const result = await withTransactionTimeout(ctx, async (tx) => {
		const t = createTableResolver(ctx.options.schema);

		// Idempotency check
		const idem = await checkIdempotencyKeyInTx(tx, {
			idempotencyKey: params.idempotencyKey,
			reference,
			ledgerId,
		});
		if (idem.alreadyProcessed && isValidCachedResult(idem.cachedResult)) {
			return idem.cachedResult as LedgerTransaction;
		}

		// Get destination account (FOR UPDATE)
		const destAccount = await resolveAccountForUpdate(
			tx,
			ledgerId,
			holderId,
			ctx.options.schema,
			ctx.options.advanced.lockMode,
		);
		assertAccountActive(destAccount);

		// Limit enforcement
		await enforceLimitsWithAccountId(tx, {
			accountId: destAccount.id,
			holderId,
			amount,
			txnType: "credit",
			category,
		});

		// Resolve source system account
		const sourceSystemId = await resolveSystemAccountInTx(
			tx,
			sourceSystemAccount,
			ctx.options.schema,
			ledgerId,
		);

		const correlationId = randomUUID();
		const acctCurrency = destAccount.currency;

		// Pre-compute balance
		const balanceBefore = Number(destAccount.balance);
		const balanceAfter = balanceBefore + amount;
		const newVersion = Number(destAccount.version) + 1;
		const newCreditBalance = Number(destAccount.credit_balance) + amount;
		const newDebitBalance = Number(destAccount.debit_balance);
		const fullMetadata = { ...metadata, category };

		// Look up prev hashes for both chains
		const [userPrevHash, systemPrevHash] = await Promise.all([
			getPrevHash(tx, t, destAccount.id),
			getPrevHash(tx, t, sourceSystemId),
		]);

		// Execute ALL writes in a single mega CTE
		const megaResult = await executeMegaCTE({
			tx,
			schema: ctx.options.schema,
			ledgerId,
			hmacSecret: ctx.options.advanced.hmacSecret,

			txnType: "credit",
			reference,
			amount,
			currency: acctCurrency,
			description,
			metadata: fullMetadata,
			correlationId,

			sourceAccountId: null,
			destinationAccountId: destAccount.id,

			userAccountId: destAccount.id,
			userEntryType: "CREDIT",
			balanceBefore,
			balanceAfter,
			newVersion,
			newCreditBalance,
			newDebitBalance,
			pendingDebit: Number(destAccount.pending_debit),
			pendingCredit: Number(destAccount.pending_credit),

			systemAccountId: sourceSystemId,
			systemEntryType: "DEBIT",

			userPrevHash,
			systemPrevHash,

			outboxTopic: "ledger-account-credited",
			outboxPayload: {
				accountId: destAccount.id,
				holderId,
				holderType: destAccount.holder_type,
				amount,
				transactionId: "",
				reference,
				category,
			},

			idempotencyKey: params.idempotencyKey,
			idempotencyResultData: undefined,
			idempotencyTTLSeconds: Math.ceil((ctx.options.advanced.idempotencyTTL ?? 86_400_000) / 1000),

			effectiveDate: params.effectiveDate ?? null,
		});

		// Build response from in-memory values
		const response: LedgerTransaction = rawToTransactionResponse(
			{
				id: megaResult.transferId,
				ledger_id: ledgerId,
				type: "credit",
				status: "posted",
				reference,
				amount,
				currency: acctCurrency,
				description,
				source_account_id: null,
				destination_account_id: destAccount.id,
				correlation_id: correlationId,
				metadata: fullMetadata,
				is_hold: false,
				hold_expires_at: null,
				parent_id: null,
				is_reversal: false,
				committed_amount: null,
				refunded_amount: null,
				effective_date: megaResult.effectiveDate,
				posted_at: megaResult.createdAt,
				created_at: megaResult.createdAt,
			} as RawTransferRow,
			"credit",
			acctCurrency,
		);

		return response;
	});

	await runAfterTransactionHooks(ctx, hookParams);
	await runAfterOperationHooks(ctx, {
		type: "transaction.credit",
		params: { holderId, amount, reference, category },
	});
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
		idempotencyKey?: string;
		effectiveDate?: Date | string;
		balancing?: boolean;
		/** @internal Skip balance & overdraft checks (used by forceDebit). */
		_skipBalanceCheck?: boolean;
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
	} = params;

	validateAmount(amount, ctx.options.advanced.maxTransactionAmount);
	const ledgerId = getLedgerId(ctx);

	// --- Batching fast path ---
	const batchEngine = (ctx as SummaContext & { batchEngine?: TransactionBatchEngine }).batchEngine;
	if (ctx.options.advanced.enableBatching && batchEngine && !params._skipBalanceCheck) {
		return batchEngine.submit({
			type: "debit",
			holderId,
			amount,
			reference,
			description,
			category,
			metadata,
			systemAccount: destinationSystemAccount,
			allowOverdraft: false,
			idempotencyKey: params.idempotencyKey,
		});
	}

	const hookParams = { type: "debit" as const, amount, reference, holderId, category, ctx };
	await runBeforeTransactionHooks(ctx, hookParams);

	const result = await withTransactionTimeout(ctx, async (tx) => {
		const t = createTableResolver(ctx.options.schema);

		const idem = await checkIdempotencyKeyInTx(tx, {
			idempotencyKey: params.idempotencyKey,
			reference,
			ledgerId,
		});
		if (idem.alreadyProcessed && isValidCachedResult(idem.cachedResult)) {
			return idem.cachedResult as LedgerTransaction;
		}

		// Get source account (FOR UPDATE)
		const sourceAccount = await resolveAccountForUpdate(
			tx,
			ledgerId,
			holderId,
			ctx.options.schema,
			ctx.options.advanced.lockMode,
		);
		assertAccountActive(sourceAccount);

		// Limit enforcement
		await enforceLimitsWithAccountId(tx, {
			accountId: sourceAccount.id,
			holderId,
			amount,
			txnType: "debit",
			category,
		});

		// Balancing debit: cap amount to available balance
		const availableBalance = Number(sourceAccount.balance) - Number(sourceAccount.pending_debit);
		let actualAmount = amount;
		if (params.balancing) {
			actualAmount = Math.min(amount, Math.max(0, availableBalance));
		}

		// Check sufficient balance (skipped for forceDebit)
		if (!params._skipBalanceCheck && !params.balancing) {
			checkSufficientBalance({
				available: availableBalance,
				amount: actualAmount,
				allowOverdraft: sourceAccount.allow_overdraft,
				overdraftLimit: Number(sourceAccount.overdraft_limit ?? 0),
			});
		}

		// Resolve destination system account
		const destSystemId = await resolveSystemAccountInTx(
			tx,
			destinationSystemAccount,
			ctx.options.schema,
			ledgerId,
		);

		const correlationId = randomUUID();
		const acctCurrency = sourceAccount.currency;

		// Pre-compute balance
		const balanceBefore = Number(sourceAccount.balance);
		const balanceAfter = balanceBefore - actualAmount;
		const newVersion = Number(sourceAccount.version) + 1;
		const newCreditBalance = Number(sourceAccount.credit_balance);
		const newDebitBalance = Number(sourceAccount.debit_balance) + actualAmount;
		const fullMetadata = params.balancing
			? { ...metadata, category, balancing: true, requestedAmount: amount }
			: { ...metadata, category };

		// Look up prev hashes for both chains
		const [userPrevHash, systemPrevHash] = await Promise.all([
			getPrevHash(tx, t, sourceAccount.id),
			getPrevHash(tx, t, destSystemId),
		]);

		// Execute ALL writes in a single mega CTE
		const megaResult = await executeMegaCTE({
			tx,
			schema: ctx.options.schema,
			ledgerId,
			hmacSecret: ctx.options.advanced.hmacSecret,

			txnType: "debit",
			reference,
			amount: actualAmount,
			currency: acctCurrency,
			description,
			metadata: fullMetadata,
			correlationId,

			sourceAccountId: sourceAccount.id,
			destinationAccountId: null,

			userAccountId: sourceAccount.id,
			userEntryType: "DEBIT",
			balanceBefore,
			balanceAfter,
			newVersion,
			newCreditBalance,
			newDebitBalance,
			pendingDebit: Number(sourceAccount.pending_debit),
			pendingCredit: Number(sourceAccount.pending_credit),

			systemAccountId: destSystemId,
			systemEntryType: "CREDIT",

			userPrevHash,
			systemPrevHash,

			outboxTopic: "ledger-account-debited",
			outboxPayload: {
				accountId: sourceAccount.id,
				holderId,
				holderType: sourceAccount.holder_type,
				amount: actualAmount,
				transactionId: "",
				reference,
				category,
			},

			idempotencyKey: params.idempotencyKey,
			idempotencyResultData: undefined,
			idempotencyTTLSeconds: Math.ceil((ctx.options.advanced.idempotencyTTL ?? 86_400_000) / 1000),

			effectiveDate: params.effectiveDate ?? null,
		});

		// Build response
		const response: LedgerTransaction = rawToTransactionResponse(
			{
				id: megaResult.transferId,
				ledger_id: ledgerId,
				type: "debit",
				status: "posted",
				reference,
				amount: actualAmount,
				currency: acctCurrency,
				description,
				source_account_id: sourceAccount.id,
				destination_account_id: null,
				correlation_id: correlationId,
				metadata: fullMetadata,
				is_hold: false,
				hold_expires_at: null,
				parent_id: null,
				is_reversal: false,
				committed_amount: null,
				refunded_amount: null,
				effective_date: megaResult.effectiveDate,
				posted_at: megaResult.createdAt,
				created_at: megaResult.createdAt,
			} as RawTransferRow,
			"debit",
			acctCurrency,
		);

		return response;
	});

	await runAfterTransactionHooks(ctx, hookParams);
	await runAfterOperationHooks(ctx, {
		type: "transaction.debit",
		params: { holderId, amount, reference, category },
	});
	return result;
}

// =============================================================================
// FORCE DEBIT — Privileged debit that bypasses balance & overdraft checks
// =============================================================================

export async function forceDebit(
	ctx: SummaContext,
	params: {
		holderId: string;
		amount: number;
		reference: string;
		reason: string;
		description?: string;
		category?: string;
		metadata?: Record<string, unknown>;
		destinationSystemAccount?: string;
		idempotencyKey?: string;
		effectiveDate?: Date | string;
	},
): Promise<LedgerTransaction> {
	const { reason, ...debitParams } = params;
	return debitAccount(ctx, {
		...debitParams,
		metadata: { ...debitParams.metadata, forceReason: reason },
		_skipBalanceCheck: true,
	});
}

// =============================================================================
// FORCE TRANSFER — Privileged transfer that bypasses balance & overdraft checks
// =============================================================================

export async function forceTransfer(
	ctx: SummaContext,
	params: {
		sourceHolderId: string;
		destinationHolderId: string;
		amount: number;
		reference: string;
		reason: string;
		description?: string;
		category?: string;
		metadata?: Record<string, unknown>;
		idempotencyKey?: string;
		exchangeRate?: number;
		effectiveDate?: Date | string;
	},
): Promise<LedgerTransaction> {
	const { reason, ...transferParams } = params;
	return transfer(ctx, {
		...transferParams,
		metadata: { ...transferParams.metadata, forceReason: reason },
		_skipBalanceCheck: true,
	});
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
		exchangeRate?: number;
		effectiveDate?: Date | string;
		balancing?: boolean;
		/** @internal Skip balance & overdraft checks (used by forceTransfer). */
		_skipBalanceCheck?: boolean;
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

	validateAmount(amount, ctx.options.advanced.maxTransactionAmount);
	const ledgerId = getLedgerId(ctx);

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
		const t = createTableResolver(ctx.options.schema);

		const idem = await checkIdempotencyKeyInTx(tx, {
			idempotencyKey: params.idempotencyKey,
			reference,
			ledgerId,
		});
		if (idem.alreadyProcessed && isValidCachedResult(idem.cachedResult)) {
			return idem.cachedResult as LedgerTransaction;
		}

		// Look up both accounts, then lock in sorted ID order to prevent deadlocks
		const lookupRows = await tx.raw<Pick<RawAccountRow, "id" | "holder_id">>(
			`SELECT id, holder_id FROM ${t("account")}
       WHERE holder_id IN ($1, $2) AND ledger_id = $3 AND is_system = false`,
			[sourceHolderId, destinationHolderId, ledgerId],
		);

		const srcPreview = lookupRows.find((r) => r.holder_id === sourceHolderId);
		const destPreview = lookupRows.find((r) => r.holder_id === destinationHolderId);

		if (!srcPreview) throw SummaError.notFound("Source account not found");
		if (!destPreview) throw SummaError.notFound("Destination account not found");

		// Lock both in deterministic ID order
		const [firstId, secondId] = [srcPreview.id, destPreview.id].sort();
		const isOptimistic = ctx.options.advanced.lockMode === "optimistic";
		const lockSuffix = isOptimistic
			? ""
			: ctx.options.advanced.lockMode === "nowait"
				? "FOR UPDATE NOWAIT"
				: "FOR UPDATE";

		if (!isOptimistic) {
			await tx.raw(`SELECT id FROM ${t("account")} WHERE id = $1 ${lockSuffix}`, [firstId]);
			await tx.raw(`SELECT id FROM ${t("account")} WHERE id = $1 ${lockSuffix}`, [secondId]);
		}

		// Read full account rows (balance is directly on account in v2)
		const allRows = await tx.raw<RawAccountRow>(
			`SELECT * FROM ${t("account")} WHERE id IN ($1, $2)`,
			[firstId, secondId],
		);

		const source = allRows.find((r) => r.id === srcPreview.id);
		const dest = allRows.find((r) => r.id === destPreview.id);

		if (!source) throw SummaError.notFound("Source account not found");
		if (!dest) throw SummaError.notFound("Destination account not found");
		assertAccountActive(source, "Source");
		assertAccountActive(dest, "Destination");

		// Check sufficient balance
		const availableBalance = Number(source.balance) - Number(source.pending_debit);
		let actualAmount = amount;
		if (params.balancing) {
			actualAmount = Math.min(amount, Math.max(0, availableBalance));
		}

		if (!params._skipBalanceCheck && !params.balancing) {
			checkSufficientBalance({
				available: availableBalance,
				amount: actualAmount,
				allowOverdraft: source.allow_overdraft,
				overdraftLimit: Number(source.overdraft_limit ?? 0),
			});
		}

		// Enforce velocity limits
		await enforceLimitsWithAccountId(tx, {
			accountId: source.id,
			holderId: sourceHolderId,
			amount: actualAmount,
			txnType: "debit",
			category,
		});

		const srcCurrency = source.currency;
		const destCurrency = dest.currency;
		const isCrossCurrency = srcCurrency !== destCurrency;

		// Auto-resolve exchange rate from FX Engine if available
		let resolvedExchangeRate = params.exchangeRate;

		if (isCrossCurrency && resolvedExchangeRate == null) {
			if (ctx.fxResolver) {
				resolvedExchangeRate = await ctx.fxResolver(srcCurrency, destCurrency);
			} else {
				throw SummaError.invalidArgument(
					`Cross-currency transfer requires exchangeRate or the fx-engine plugin (source: ${srcCurrency}, destination: ${destCurrency})`,
				);
			}
		}

		// Validate exchange rate bounds
		if (resolvedExchangeRate != null) {
			if (
				!Number.isInteger(resolvedExchangeRate) ||
				resolvedExchangeRate <= 0 ||
				resolvedExchangeRate > 1_000_000_000
			) {
				throw SummaError.invalidArgument(
					"exchangeRate must be a positive integer (rate * 1_000_000 for 6 decimal precision), max 1_000_000_000",
				);
			}
		}

		// For cross-currency: credit amount in destination currency
		const fxRate = resolvedExchangeRate ?? 1_000_000;
		const creditAmount = isCrossCurrency
			? Math.round(actualAmount * (fxRate / 1_000_000))
			: actualAmount;

		if (isCrossCurrency && creditAmount <= 0) {
			throw SummaError.invalidArgument(
				"Cross-currency transfer resulted in zero or negative credit amount. Check exchangeRate.",
			);
		}

		const correlationId = randomUUID();

		// FX params for cross-currency transfers
		const fxParams = isCrossCurrency
			? {
					originalAmount: amount,
					originalCurrency: srcCurrency,
					exchangeRate: resolvedExchangeRate,
				}
			: {};

		// Create transfer record
		const txnMeta = isCrossCurrency
			? { ...metadata, category, exchangeRate: resolvedExchangeRate, crossCurrency: true }
			: params.balancing
				? { ...metadata, category, balancing: true, requestedAmount: amount }
				: { ...metadata, category };
		const txnRecordRows = await tx.raw<RawTransferRow>(
			`INSERT INTO ${t("transfer")} (ledger_id, type, status, reference, amount, currency, description, source_account_id, destination_account_id, correlation_id, metadata, posted_at, effective_date)
       VALUES ($1, $2, 'posted', $3, $4, $5, $6, $7, $8, $9, $10, NOW(), COALESCE($11::timestamptz, NOW()))
       RETURNING *`,
			[
				ledgerId,
				"transfer",
				reference,
				actualAmount,
				srcCurrency,
				description,
				source.id,
				dest.id,
				correlationId,
				JSON.stringify(txnMeta),
				params.effectiveDate ?? null,
			],
		);
		const txnRecord = txnRecordRows[0];
		if (!txnRecord) throw SummaError.internal("Failed to insert transfer");

		// Entry + balance updates for both accounts (skipLock: both already locked above)
		await Promise.all([
			insertEntryAndUpdateBalance({
				tx,
				transferId: txnRecord.id,
				accountId: source.id,
				entryType: "DEBIT",
				amount: actualAmount,
				currency: srcCurrency,
				isHotAccount: false,
				skipLock: true,
				...fxParams,
			}),
			insertEntryAndUpdateBalance({
				tx,
				transferId: txnRecord.id,
				accountId: dest.id,
				entryType: "CREDIT",
				amount: creditAmount,
				currency: destCurrency,
				isHotAccount: false,
				skipLock: true,
				...fxParams,
			}),
		]);

		const response = rawToTransactionResponse(txnRecord, "transfer", srcCurrency);
		await batchTransactionSideEffects({
			tx,
			ctx,
			txnRecord,
			correlationId,
			reference,
			category,
			ledgerId,
			outboxEvents: [
				{
					topic: "ledger-account-debited",
					payload: {
						accountId: source.id,
						holderId: sourceHolderId,
						holderType: source.holder_type,
						amount: actualAmount,
						transactionId: txnRecord.id,
						reference,
						category,
						type: "transfer",
					},
				},
				{
					topic: "ledger-account-credited",
					payload: {
						accountId: dest.id,
						holderId: destinationHolderId,
						holderType: dest.holder_type,
						amount: creditAmount,
						transactionId: txnRecord.id,
						reference,
						category,
						type: "transfer",
					},
				},
			],
			idempotencyKey: params.idempotencyKey,
			responseForIdempotency: response,
		});

		return response;
	});

	await runAfterTransactionHooks(ctx, hookParams);
	await runAfterOperationHooks(ctx, {
		type: "transaction.transfer",
		params: { sourceHolderId, destinationHolderId, amount, reference, category },
	});
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
		effectiveDate?: Date | string;
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

	validateAmount(amount, ctx.options.advanced.maxTransactionAmount);
	const ledgerId = getLedgerId(ctx);

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
		const t = createTableResolver(ctx.options.schema);

		const idem = await checkIdempotencyKeyInTx(tx, {
			idempotencyKey: params.idempotencyKey,
			reference,
			ledgerId,
		});
		if (idem.alreadyProcessed && isValidCachedResult(idem.cachedResult)) {
			return idem.cachedResult as LedgerTransaction;
		}

		// Lock source account
		const source = await resolveAccountForUpdate(
			tx,
			ledgerId,
			sourceHolderId,
			ctx.options.schema,
			ctx.options.advanced.lockMode,
		);
		assertAccountActive(source);

		// Check sufficient balance
		const availableBalance = Number(source.balance) - Number(source.pending_debit);
		checkSufficientBalance({
			available: availableBalance,
			amount,
			allowOverdraft: source.allow_overdraft,
			overdraftLimit: Number(source.overdraft_limit ?? 0),
		});

		// Enforce velocity limits on source
		await enforceLimitsWithAccountId(tx, {
			accountId: source.id,
			holderId: sourceHolderId,
			amount,
			txnType: "debit",
			category,
		});

		const acctCurrency = source.currency;
		const correlationId = randomUUID();

		// Create transfer record
		const txnRecordRows = await tx.raw<RawTransferRow>(
			`INSERT INTO ${t("transfer")} (ledger_id, type, status, reference, amount, currency, description, source_account_id, correlation_id, metadata, posted_at, effective_date)
       VALUES ($1, $2, 'posted', $3, $4, $5, $6, $7, $8, $9, NOW(), COALESCE($10::timestamptz, NOW()))
       RETURNING *`,
			[
				ledgerId,
				"transfer",
				reference,
				amount,
				acctCurrency,
				description,
				source.id,
				correlationId,
				JSON.stringify({ ...metadata, category, destinations }),
				params.effectiveDate ?? null,
			],
		);
		const txnRecord = txnRecordRows[0];
		if (!txnRecord) throw SummaError.internal("Failed to insert multi-transfer");

		// DEBIT entry for source (skipLock: already locked above)
		await insertEntryAndUpdateBalance({
			tx,
			transferId: txnRecord.id,
			accountId: source.id,
			entryType: "DEBIT",
			amount,
			currency: acctCurrency,
			isHotAccount: false,
			skipLock: true,
		});

		// Credit all destinations
		const destResults = await creditMultiDestinations(tx, ctx, {
			transferId: txnRecord.id,
			currency: acctCurrency,
			totalAmount: amount,
			destinations,
		});

		// Build outbox events
		const outboxEvents: Array<{ topic: string; payload: Record<string, unknown> }> = [
			{
				topic: "ledger-account-debited",
				payload: {
					accountId: source.id,
					holderId: sourceHolderId,
					holderType: source.holder_type,
					amount,
					transactionId: txnRecord.id,
					reference,
					category,
					type: "multi-transfer",
				},
			},
		];

		for (const dest of destResults) {
			if (dest.accountId && dest.holderId) {
				outboxEvents.push({
					topic: "ledger-account-credited",
					payload: {
						accountId: dest.accountId,
						holderId: dest.holderId,
						amount: dest.amount,
						transactionId: txnRecord.id,
						reference,
						category,
						type: "multi-transfer",
					},
				});
			}
		}

		const response = rawToTransactionResponse(txnRecord, "transfer", acctCurrency);
		await batchTransactionSideEffects({
			tx,
			ctx,
			txnRecord,
			correlationId,
			reference,
			category,
			ledgerId,
			outboxEvents,
			idempotencyKey: params.idempotencyKey,
			responseForIdempotency: response,
		});

		return response;
	});

	await runAfterTransactionHooks(ctx, hookParams);
	await runAfterOperationHooks(ctx, {
		type: "transaction.transfer",
		params: { sourceHolderId, amount, reference, category, destinations },
	});
	return result;
}

// =============================================================================
// GET / LIST TRANSACTIONS
// =============================================================================

export async function getTransaction(
	ctx: SummaContext,
	transactionId: string,
): Promise<LedgerTransaction> {
	const ledgerId = getLedgerId(ctx);
	const t = createTableResolver(ctx.options.schema);
	const rows = await ctx.readAdapter.raw<RawTransferRow>(
		`${transferSelectSql(t)} WHERE id = $1 AND ledger_id = $2 LIMIT 1`,
		[transactionId, ledgerId],
	);

	const txn = rows[0];
	if (!txn) throw SummaError.notFound("Transaction not found");

	return rawToTransactionResponse(txn, inferTransactionType(txn), txn.currency);
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
		cursor?: string;
		limit?: number;
	},
): Promise<{
	transactions: LedgerTransaction[];
	hasMore: boolean;
	total: number;
	nextCursor?: string;
}> {
	const VALID_STATUSES: ReadonlySet<string> = new Set([
		"pending",
		"inflight",
		"posted",
		"expired",
		"voided",
		"reversed",
	]);
	const VALID_TYPES: ReadonlySet<string> = new Set([
		"credit",
		"debit",
		"transfer",
		"journal",
		"correction",
		"adjustment",
	]);

	if (params.status && !VALID_STATUSES.has(params.status)) {
		throw SummaError.invalidArgument(
			`Invalid status: "${params.status}". Must be one of: ${[...VALID_STATUSES].join(", ")}`,
		);
	}
	if (params.type && !VALID_TYPES.has(params.type)) {
		throw SummaError.invalidArgument(
			`Invalid type: "${params.type}". Must be one of: ${[...VALID_TYPES].join(", ")}`,
		);
	}

	const ledgerId = getLedgerId(ctx);
	const t = createTableResolver(ctx.options.schema);

	// Find the account
	const accountRows = await ctx.readAdapter.raw<{ id: string }>(
		`SELECT id FROM ${t("account")} WHERE holder_id = $1 AND ledger_id = $2 AND is_system = false LIMIT 1`,
		[params.holderId, ledgerId],
	);

	if (!accountRows[0]) throw SummaError.notFound("Account not found");
	const accountId = accountRows[0].id;

	// Build filter SQL — status is a direct column on transfer now (no LATERAL JOIN)
	const filterParts: string[] = [];
	const filterParams: unknown[] = [];
	let pIdx = 1;

	filterParams.push(accountId);
	pIdx++;

	if (params.status) {
		filterParts.push(`AND tr.status = $${pIdx++}`);
		filterParams.push(params.status);
	}
	if (params.category) {
		filterParts.push(`AND tr.metadata->>'category' = $${pIdx++}`);
		filterParams.push(params.category);
	}
	if (params.dateFrom) {
		filterParts.push(`AND tr.created_at >= $${pIdx++}::timestamptz`);
		filterParams.push(params.dateFrom);
	}
	if (params.dateTo) {
		filterParts.push(`AND tr.created_at <= $${pIdx++}::timestamptz`);
		filterParams.push(params.dateTo);
	}
	if (params.amountMin != null) {
		filterParts.push(`AND tr.amount >= $${pIdx++}`);
		filterParams.push(params.amountMin);
	}
	if (params.amountMax != null) {
		filterParts.push(`AND tr.amount <= $${pIdx++}`);
		filterParams.push(params.amountMax);
	}

	const commonFilters = filterParts.join(" ");
	const orderCol = params.sortBy === "amount" ? "amount DESC" : "created_at DESC";

	// Build query — no more LATERAL JOIN for status (it's on the transfer row)
	const baseSelect = `SELECT tr.* FROM ${t("transfer")} tr`;

	let unionQuery: string;
	if (params.type === "credit") {
		unionQuery = `
      ${baseSelect} WHERE tr.destination_account_id = $1 AND (tr.source_account_id IS NULL OR tr.source_account_id != $1) ${commonFilters}
      UNION ALL
      ${baseSelect}
      JOIN ${t("entry")} er ON er.transfer_id = tr.id
      WHERE er.account_id = $1
        AND er.entry_type = 'CREDIT'
        AND tr.source_account_id IS NOT NULL
        AND tr.destination_account_id IS NULL
        AND tr.source_account_id != $1
        ${commonFilters}
    `;
	} else if (params.type === "debit") {
		unionQuery = `${baseSelect} WHERE tr.source_account_id = $1 ${commonFilters}`;
	} else if (params.type === "transfer") {
		unionQuery = `
      ${baseSelect} WHERE tr.source_account_id = $1 AND tr.destination_account_id IS NOT NULL ${commonFilters}
      UNION ALL
      ${baseSelect} WHERE tr.destination_account_id = $1 AND tr.source_account_id IS NOT NULL AND tr.source_account_id != $1 ${commonFilters}
    `;
	} else {
		unionQuery = `
      ${baseSelect} WHERE tr.source_account_id = $1 ${commonFilters}
      UNION ALL
      ${baseSelect} WHERE tr.destination_account_id = $1 AND (tr.source_account_id IS NULL OR tr.source_account_id != $1) ${commonFilters}
      UNION ALL
      ${baseSelect}
      JOIN ${t("entry")} er ON er.transfer_id = tr.id
      WHERE er.account_id = $1
        AND er.entry_type = 'CREDIT'
        AND tr.source_account_id IS NOT NULL
        AND tr.destination_account_id IS NULL
        AND tr.source_account_id != $1
        ${commonFilters}
    `;
	}

	const perPage = Math.min(params.limit ?? params.perPage ?? 20, 100);

	// Cursor-based pagination
	const useCursor = params.cursor != null;
	const cursorData = useCursor && params.cursor ? decodeCursor(params.cursor) : null;
	if (useCursor && !cursorData) {
		throw SummaError.invalidArgument("Invalid cursor");
	}

	if (useCursor && cursorData) {
		const cursorFilter = `WHERE (combined.created_at, combined.id) < ($${pIdx}::timestamptz, $${pIdx + 1})`;
		filterParams.push(cursorData.ca, cursorData.id);
		pIdx += 2;
		filterParams.push(perPage + 1);

		const rows = await ctx.readAdapter.raw<RawTransferRow>(
			`SELECT * FROM (
           ${unionQuery}
         ) combined
         ${cursorFilter}
         ORDER BY combined.created_at DESC, combined.id DESC
         LIMIT $${pIdx}`,
			filterParams,
		);

		const hasMore = rows.length > perPage;
		const data = (hasMore ? rows.slice(0, perPage) : rows).map((txn) =>
			rawToTransactionResponse(txn, inferTransactionType(txn), txn.currency),
		);
		const lastRow = hasMore ? rows[perPage - 1] : undefined;
		const nextCursor = lastRow ? encodeCursor(lastRow.created_at, lastRow.id) : undefined;

		return { transactions: data, hasMore, total: -1, nextCursor };
	}

	// OFFSET/LIMIT pagination
	const page = Math.max(1, params.page ?? 1);
	const offset = (page - 1) * perPage;

	filterParams.push(perPage + 1);
	filterParams.push(offset);

	const rows = await ctx.readAdapter.raw<RawTransferRow & { total_count: number }>(
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
	const data = (hasMore ? rows.slice(0, perPage) : rows).map((txn) =>
		rawToTransactionResponse(txn, inferTransactionType(txn), txn.currency),
	);
	const lastRow = hasMore ? rows[perPage - 1] : undefined;
	const nextCursor = lastRow ? encodeCursor(lastRow.created_at, lastRow.id) : undefined;

	return { transactions: data, hasMore, total, nextCursor };
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
	const ledgerId = getLedgerId(ctx);

	const result = await withTransactionTimeout(ctx, async (tx) => {
		const t = createTableResolver(ctx.options.schema);

		// Lock original transfer + read status (status is directly on transfer row)
		const originalRows = await tx.raw<RawTransferRow>(
			`SELECT * FROM ${t("transfer")} WHERE id = $1 FOR UPDATE`,
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

		// Idempotency check
		const idem = await checkIdempotencyKeyInTx(tx, {
			idempotencyKey: params.idempotencyKey,
			reference: refundReference,
			ledgerId,
		});
		if (idem.alreadyProcessed && isValidCachedResult(idem.cachedResult)) {
			return idem.cachedResult as LedgerTransaction;
		}

		const correlationId = randomUUID();

		// Update refunded_amount on original transfer (mutable status in v2)
		const newRefundedAmount = alreadyRefunded + actualRefundAmount;
		const newStatus = newRefundedAmount >= originalAmount ? "reversed" : "posted";
		await tx.raw(
			`UPDATE ${t("transfer")} SET status = $1, refunded_amount = $2 WHERE id = $3`,
			[newStatus, newRefundedAmount, transactionId],
		);

		// Log status transition
		await tx.raw(
			`INSERT INTO ${t("entity_status_log")} (entity_type, entity_id, status, previous_status, reason)
       VALUES ('transfer', $1, $2, 'posted', $3)`,
			[transactionId, newStatus, `Refund: ${reason}`],
		);

		// Create reversal transfer record
		const reversalRows = await tx.raw<RawTransferRow>(
			`INSERT INTO ${t("transfer")} (ledger_id, type, status, reference, amount, currency, description, source_account_id, destination_account_id, parent_id, is_reversal, correlation_id, metadata, posted_at)
       VALUES ($1, $2, 'posted', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
       RETURNING *`,
			[
				ledgerId,
				"correction",
				refundReference,
				actualRefundAmount,
				original.currency,
				`Refund: ${reason}`,
				original.destination_account_id,
				original.source_account_id,
				original.id,
				true,
				correlationId,
				JSON.stringify({ reason, originalTransactionId: transactionId }),
			],
		);
		const reversal = reversalRows[0];
		if (!reversal) throw SummaError.internal("Failed to insert refund reversal");

		// Reverse entries for user accounts
		if (original.destination_account_id) {
			await insertEntryAndUpdateBalance({
				tx,
				transferId: reversal.id,
				accountId: original.destination_account_id,
				entryType: "DEBIT",
				amount: actualRefundAmount,
				currency: original.currency,
				isHotAccount: false,
			});
		}

		if (original.source_account_id) {
			await insertEntryAndUpdateBalance({
				tx,
				transferId: reversal.id,
				accountId: original.source_account_id,
				entryType: "CREDIT",
				amount: actualRefundAmount,
				currency: original.currency,
				isHotAccount: false,
			});
		}

		// Build outbox events
		const outboxEvents: Array<{ topic: string; payload: Record<string, unknown> }> = [];

		if (original.destination_account_id) {
			outboxEvents.push({
				topic: "ledger-account-debited",
				payload: {
					accountId: original.destination_account_id,
					amount: actualRefundAmount,
					transactionId: reversal.id,
					reference: reversal.reference,
					category: "refund",
					type: "refund",
				},
			});
		}
		if (original.source_account_id) {
			outboxEvents.push({
				topic: "ledger-account-credited",
				payload: {
					accountId: original.source_account_id,
					amount: actualRefundAmount,
					transactionId: reversal.id,
					reference: reversal.reference,
					category: "refund",
					type: "refund",
				},
			});
		}

		const response = rawToTransactionResponse(reversal, "correction", original.currency);
		await batchTransactionSideEffects({
			tx,
			ctx,
			txnRecord: reversal,
			correlationId,
			reference: reversal.reference,
			category: "refund",
			ledgerId,
			outboxEvents,
			idempotencyKey: params.idempotencyKey,
			responseForIdempotency: response,
		});

		return response;
	});

	await runAfterOperationHooks(ctx, {
		type: "transaction.refund",
		params: { transactionId, reason, amount: refundAmount },
	});
	return result;
}

// =============================================================================
// HELPERS
// =============================================================================

function inferTransactionType(txn: RawTransferRow): TransactionType {
	return (txn.type ?? "credit") as TransactionType;
}
