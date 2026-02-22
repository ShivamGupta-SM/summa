// =============================================================================
// TRANSACTION MANAGER -- Double-entry transaction operations (APPEND-ONLY)
// =============================================================================
// Every transaction creates balanced debit + credit entry records.
// System accounts use hot account pattern for high-volume batching.
//
// After the immutability refactor:
// - transaction_record is IMMUTABLE (no status, posted_at, committed_amount, refunded_amount)
// - transaction_status is APPEND-ONLY (each status transition = new row)
// - account_balance is IMMUTABLE, state in account_balance_version (append-only)

import { randomUUID } from "node:crypto";
import type {
	HoldDestination,
	LedgerTransaction,
	SummaContext,
	TransactionStatus,
	TransactionType,
} from "@summa-ledger/core";
import {
	computeBalanceChecksum,
	decodeCursor,
	encodeCursor,
	SummaError,
	TRANSACTION_EVENTS,
} from "@summa-ledger/core";
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
import { executeMegaCTE, updateDenormalizedCache } from "./mega-cte.js";
import { creditMultiDestinations } from "./multi-dest-credit.js";
import type { RawAccountRow, RawTransactionRow } from "./raw-types.js";
import { rawToTransactionResponse, txnWithStatusSql } from "./sql-helpers.js";
import {
	assertAccountActive,
	batchTransactionSideEffects,
	insertHotAccountEntry,
	resolveSystemAccountInTx,
	validateAmount,
} from "./transaction-helpers.js";

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
		/** Effective date for backdated transactions. Defaults to NOW(). */
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

	// --- Batching fast path: delegate to batch engine if enabled ---
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
		// Idempotency check INSIDE transaction for atomicity
		const idem = await checkIdempotencyKeyInTx(tx, {
			idempotencyKey: params.idempotencyKey,
			reference,
			ledgerId,
		});
		if (idem.alreadyProcessed && isValidCachedResult(idem.cachedResult)) {
			return idem.cachedResult as LedgerTransaction;
		}

		// Get destination account (FOR UPDATE to prevent stale reads)
		const destAccount = await resolveAccountForUpdate(
			tx,
			ledgerId,
			holderId,
			ctx.options.schema,
			ctx.options.advanced.lockMode,
			ctx.options.advanced.useDenormalizedBalance,
		);
		assertAccountActive(destAccount);

		// Limit enforcement inside tx
		await enforceLimitsWithAccountId(tx, {
			accountId: destAccount.id,
			holderId,
			amount,
			txnType: "credit",
			category,
		});

		// Get source system account (cached — no DB hit after first call)
		const sourceSystemId = await resolveSystemAccountInTx(
			tx,
			sourceSystemAccount,
			ctx.options.schema,
			ledgerId,
		);

		const correlationId = randomUUID();
		const acctCurrency = destAccount.currency;

		// Pre-compute balance update in-memory
		const balanceBefore = Number(destAccount.balance);
		const balanceAfter = balanceBefore + amount;
		const newVersion = Number(destAccount.version) + 1;
		const newCreditBalance = Number(destAccount.credit_balance) + amount;
		const newDebitBalance = Number(destAccount.debit_balance);
		const fullMetadata = { ...metadata, category };

		const eventData = {
			reference,
			amount,
			source: sourceSystemAccount,
			destination: holderId,
			category,
		};

		// Execute ALL writes in a single mega CTE (1 DB round-trip)
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
			sourceSystemAccountId: sourceSystemId,
			destinationSystemAccountId: null,

			userAccountId: destAccount.id,
			userEntryType: "CREDIT",
			balanceBefore,
			balanceAfter,
			newVersion,
			newCreditBalance,
			newDebitBalance,
			pendingDebit: Number(destAccount.pending_debit),
			pendingCredit: Number(destAccount.pending_credit),
			accountStatus: destAccount.status,
			freezeReason: destAccount.freeze_reason ?? null,
			frozenAt: destAccount.frozen_at ?? null,
			frozenBy: destAccount.frozen_by ?? null,
			closedAt: destAccount.closed_at ?? null,
			closedBy: destAccount.closed_by ?? null,
			closureReason: destAccount.closure_reason ?? null,

			systemAccountId: sourceSystemId,
			systemEntryType: "DEBIT",

			enableEventSourcing: ctx.options.advanced.enableEventSourcing !== false,
			eventData,

			outboxTopic: "ledger-account-credited",
			outboxPayload: {
				accountId: destAccount.id,
				holderId,
				holderType: destAccount.holder_type,
				amount,
				transactionId: "", // filled by CTE via new_txn.id
				reference,
				category,
			},

			velocityAccountId: destAccount.id,
			velocityTxnType: "credit",

			idempotencyKey: params.idempotencyKey,
			idempotencyResultData: undefined, // set below after building response
			idempotencyTTLSeconds: Math.ceil((ctx.options.advanced.idempotencyTTL ?? 86_400_000) / 1000),

			effectiveDate: params.effectiveDate ?? null,
		});

		// Update denormalized cache (separate query — trigger blocks CTE-based updates)
		if (ctx.options.advanced.useDenormalizedBalance) {
			const hmacSecret = ctx.options.advanced.hmacSecret;
			const checksum = computeBalanceChecksum(
				{
					balance: balanceAfter,
					creditBalance: newCreditBalance,
					debitBalance: newDebitBalance,
					pendingDebit: Number(destAccount.pending_debit),
					pendingCredit: Number(destAccount.pending_credit),
					lockVersion: newVersion,
				},
				hmacSecret,
			);
			await updateDenormalizedCache(tx, ctx.options.schema, destAccount.id, {
				balance: balanceAfter,
				creditBalance: newCreditBalance,
				debitBalance: newDebitBalance,
				pendingDebit: Number(destAccount.pending_debit),
				pendingCredit: Number(destAccount.pending_credit),
				version: newVersion,
				status: destAccount.status,
				checksum,
			});
		}

		// Build response from in-memory values (no extra DB read needed)
		const response: LedgerTransaction = rawToTransactionResponse(
			{
				id: megaResult.transactionId,
				reference,
				amount,
				currency: acctCurrency,
				description,
				source_account_id: null,
				destination_account_id: destAccount.id,
				source_system_account_id: sourceSystemId,
				destination_system_account_id: null,
				correlation_id: correlationId,
				is_reversal: false,
				is_hold: false,
				parent_id: null,
				meta_data: fullMetadata,
				created_at: megaResult.createdAt,
				status: "posted",
				posted_at: megaResult.createdAt,
				committed_amount: null,
				refunded_amount: 0,
				hold_expires_at: null,
				processing_at: null,
				type: "credit",
				ledger_id: ledgerId,
				effective_date: megaResult.effectiveDate,
			} as RawTransactionRow,
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
		/** Effective date for backdated transactions. Defaults to NOW(). */
		effectiveDate?: Date | string;
		/**
		 * TigerBeetle-inspired balancing debit. When true, the transfer amount is
		 * automatically capped to the available balance instead of failing with
		 * INSUFFICIENT_BALANCE. The `amount` field becomes an upper limit.
		 *
		 * Use cases: sweep all available funds, close account with final payout,
		 * distribute remaining balance.
		 *
		 * The actual debited amount is returned in the response's `amount` field.
		 * If available balance is 0, the transaction still succeeds with amount 0.
		 */
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

	// --- Batching fast path: delegate to batch engine if enabled ---
	// forceDebit (_skipBalanceCheck) bypasses batching — privileged ops go through direct path
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
		const idem = await checkIdempotencyKeyInTx(tx, {
			idempotencyKey: params.idempotencyKey,
			reference,
			ledgerId,
		});
		if (idem.alreadyProcessed && isValidCachedResult(idem.cachedResult)) {
			return idem.cachedResult as LedgerTransaction;
		}

		// Get source account (FOR UPDATE to prevent stale balance reads)
		const sourceAccount = await resolveAccountForUpdate(
			tx,
			ledgerId,
			holderId,
			ctx.options.schema,
			ctx.options.advanced.lockMode,
			ctx.options.advanced.useDenormalizedBalance,
		);
		assertAccountActive(sourceAccount);

		// Limit enforcement inside tx
		await enforceLimitsWithAccountId(tx, {
			accountId: sourceAccount.id,
			holderId,
			amount,
			txnType: "debit",
			category,
		});

		// Balancing debit (TigerBeetle-inspired): cap amount to available balance
		const availableBalance = Number(sourceAccount.balance) - Number(sourceAccount.pending_debit);
		let actualAmount = amount;
		if (params.balancing) {
			actualAmount = Math.min(amount, Math.max(0, availableBalance));
		}

		// Check sufficient balance (skipped for forceDebit — chargebacks, network adjustments)
		if (!params._skipBalanceCheck && !params.balancing) {
			checkSufficientBalance({
				available: availableBalance,
				amount: actualAmount,
				allowOverdraft: sourceAccount.allow_overdraft,
				overdraftLimit: Number(sourceAccount.overdraft_limit ?? 0),
			});
		}

		// Get destination system account (cached — no DB hit after first call)
		const destSystemId = await resolveSystemAccountInTx(
			tx,
			destinationSystemAccount,
			ctx.options.schema,
			ledgerId,
		);

		const correlationId = randomUUID();
		const acctCurrency = sourceAccount.currency;

		// Pre-compute balance update in-memory
		const balanceBefore = Number(sourceAccount.balance);
		const balanceAfter = balanceBefore - actualAmount;
		const newVersion = Number(sourceAccount.version) + 1;
		const newCreditBalance = Number(sourceAccount.credit_balance);
		const newDebitBalance = Number(sourceAccount.debit_balance) + actualAmount;
		const fullMetadata = params.balancing
			? { ...metadata, category, balancing: true, requestedAmount: amount }
			: { ...metadata, category };

		const eventData = {
			reference,
			amount: actualAmount,
			source: holderId,
			destination: destinationSystemAccount,
			category,
		};

		// Execute ALL writes in a single mega CTE (1 DB round-trip)
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
			sourceSystemAccountId: null,
			destinationSystemAccountId: destSystemId,

			userAccountId: sourceAccount.id,
			userEntryType: "DEBIT",
			balanceBefore,
			balanceAfter,
			newVersion,
			newCreditBalance,
			newDebitBalance,
			pendingDebit: Number(sourceAccount.pending_debit),
			pendingCredit: Number(sourceAccount.pending_credit),
			accountStatus: sourceAccount.status,
			freezeReason: sourceAccount.freeze_reason ?? null,
			frozenAt: sourceAccount.frozen_at ?? null,
			frozenBy: sourceAccount.frozen_by ?? null,
			closedAt: sourceAccount.closed_at ?? null,
			closedBy: sourceAccount.closed_by ?? null,
			closureReason: sourceAccount.closure_reason ?? null,

			systemAccountId: destSystemId,
			systemEntryType: "CREDIT",

			enableEventSourcing: ctx.options.advanced.enableEventSourcing !== false,
			eventData,

			outboxTopic: "ledger-account-debited",
			outboxPayload: {
				accountId: sourceAccount.id,
				holderId,
				holderType: sourceAccount.holder_type,
				amount: actualAmount,
				transactionId: "", // filled by CTE via new_txn.id
				reference,
				category,
			},

			velocityAccountId: sourceAccount.id,
			velocityTxnType: "debit",

			idempotencyKey: params.idempotencyKey,
			idempotencyResultData: undefined, // set below after building response
			idempotencyTTLSeconds: Math.ceil((ctx.options.advanced.idempotencyTTL ?? 86_400_000) / 1000),

			effectiveDate: params.effectiveDate ?? null,
		});

		// Update denormalized cache (separate query — trigger blocks CTE-based updates)
		if (ctx.options.advanced.useDenormalizedBalance) {
			const hmacSecret = ctx.options.advanced.hmacSecret;
			const checksum = computeBalanceChecksum(
				{
					balance: balanceAfter,
					creditBalance: newCreditBalance,
					debitBalance: newDebitBalance,
					pendingDebit: Number(sourceAccount.pending_debit),
					pendingCredit: Number(sourceAccount.pending_credit),
					lockVersion: newVersion,
				},
				hmacSecret,
			);
			await updateDenormalizedCache(tx, ctx.options.schema, sourceAccount.id, {
				balance: balanceAfter,
				creditBalance: newCreditBalance,
				debitBalance: newDebitBalance,
				pendingDebit: Number(sourceAccount.pending_debit),
				pendingCredit: Number(sourceAccount.pending_credit),
				version: newVersion,
				status: sourceAccount.status,
				checksum,
			});
		}

		// Build response from in-memory values (no extra DB read needed)
		const response: LedgerTransaction = rawToTransactionResponse(
			{
				id: megaResult.transactionId,
				reference,
				amount: actualAmount,
				currency: acctCurrency,
				description,
				source_account_id: sourceAccount.id,
				destination_account_id: null,
				source_system_account_id: null,
				destination_system_account_id: destSystemId,
				correlation_id: correlationId,
				is_reversal: false,
				is_hold: false,
				parent_id: null,
				meta_data: fullMetadata,
				created_at: megaResult.createdAt,
				status: "posted",
				posted_at: megaResult.createdAt,
				committed_amount: null,
				refunded_amount: 0,
				hold_expires_at: null,
				processing_at: null,
				type: "debit",
				ledger_id: ledgerId,
				effective_date: megaResult.effectiveDate,
			} as RawTransactionRow,
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
// Use for chargebacks, network-initiated adjustments, regulatory debits, and
// other cases where the debit MUST succeed regardless of account balance.

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
// Use for clawbacks, regulatory seizures, or inter-account forced moves where
// the transfer MUST succeed regardless of source account balance.

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
		/** Exchange rate for cross-currency transfers (rate * 1_000_000 for 6 decimal precision). Required when source and destination currencies differ. */
		exchangeRate?: number;
		/** Effective date for backdated transactions. Defaults to NOW(). */
		effectiveDate?: Date | string;
		/**
		 * TigerBeetle-inspired balancing transfer. When true, the transfer amount is
		 * automatically capped to the source account's available balance instead of
		 * failing with INSUFFICIENT_BALANCE. The `amount` field becomes an upper limit.
		 *
		 * Use cases: sweep all funds to another account, settlement of remaining balance.
		 *
		 * The actual transferred amount is returned in the response's `amount` field.
		 * If available balance is 0, the transaction still succeeds with amount 0.
		 */
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

		// Look up both accounts without lock first, then lock in sorted ID order
		// to prevent deadlocks when concurrent transfers go A->B and B->A.
		const lookupRows = await tx.raw<Pick<RawAccountRow, "id" | "holder_id">>(
			`SELECT id, holder_id FROM ${t("account_balance")}
       WHERE holder_id IN ($1, $2) AND ledger_id = $3`,
			[sourceHolderId, destinationHolderId, ledgerId],
		);

		const srcPreview = lookupRows.find((r) => r.holder_id === sourceHolderId);
		const destPreview = lookupRows.find((r) => r.holder_id === destinationHolderId);

		if (!srcPreview) throw SummaError.notFound("Source account not found");
		if (!destPreview) throw SummaError.notFound("Destination account not found");

		// Lock both in deterministic ID order to prevent deadlocks.
		// Lock immutable parents, then read latest version via LATERAL JOIN.
		// In optimistic mode: skip locks, read without FOR UPDATE — rely on version constraint.
		const [firstId, secondId] = [srcPreview.id, destPreview.id].sort();
		const isOptimistic = ctx.options.advanced.lockMode === "optimistic";
		const lockSuffix = isOptimistic
			? ""
			: ctx.options.advanced.lockMode === "nowait"
				? "FOR UPDATE NOWAIT"
				: "FOR UPDATE";

		// Lock both (skipped in optimistic mode)
		if (!isOptimistic) {
			await tx.raw(`SELECT id FROM ${t("account_balance")} WHERE id = $1 ${lockSuffix}`, [firstId]);
			await tx.raw(`SELECT id FROM ${t("account_balance")} WHERE id = $1 ${lockSuffix}`, [
				secondId,
			]);
		}

		// Read combined rows (static + latest version)
		const allRows = await tx.raw<RawAccountRow>(
			`SELECT a.*, v.version, v.balance, v.credit_balance, v.debit_balance,
              v.pending_credit, v.pending_debit, v.status, v.checksum,
              v.freeze_reason, v.frozen_at, v.frozen_by,
              v.closed_at, v.closed_by, v.closure_reason
       FROM ${t("account_balance")} a
       JOIN LATERAL (
         SELECT * FROM ${t("account_balance_version")}
         WHERE account_id = a.id ORDER BY version DESC LIMIT 1
       ) v ON true
       WHERE a.id IN ($1, $2)`,
			[firstId, secondId],
		);

		const source = allRows.find((r) => r.id === srcPreview.id);
		const dest = allRows.find((r) => r.id === destPreview.id);

		if (!source) throw SummaError.notFound("Source account not found");
		if (!dest) throw SummaError.notFound("Destination account not found");
		assertAccountActive(source, "Source");
		assertAccountActive(dest, "Destination");

		// Check sufficient balance first (cheap) before limit queries (expensive)
		const availableBalance = Number(source.balance) - Number(source.pending_debit);

		// Balancing transfer (TigerBeetle-inspired): cap amount to available balance
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

		// Enforce velocity limits inside tx
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

		// Validate exchange rate bounds (rate is scaled by 1_000_000 for 6 decimal precision)
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

		// For cross-currency: credit amount in destination currency.
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

		// Create transaction record (IMMUTABLE — no status)
		const txnMeta = isCrossCurrency
			? { ...metadata, category, exchangeRate: resolvedExchangeRate, crossCurrency: true }
			: params.balancing
				? { ...metadata, category, balancing: true, requestedAmount: amount }
				: { ...metadata, category };
		const txnRecordRows = await tx.raw<RawTransactionRow>(
			`INSERT INTO ${t("transaction_record")} (type, reference, amount, currency, description, source_account_id, destination_account_id, correlation_id, meta_data, ledger_id, effective_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11::timestamptz, NOW()))
       RETURNING *`,
			[
				"transfer",
				reference,
				actualAmount,
				srcCurrency,
				description,
				source.id,
				dest.id,
				correlationId,
				JSON.stringify(txnMeta),
				ledgerId,
				params.effectiveDate ?? null,
			],
		);
		const txnRecord = txnRecordRows[0];
		if (!txnRecord) throw SummaError.internal("Failed to insert transfer transaction");

		// INSERT initial status (posted immediately, APPEND-ONLY)
		await tx.raw(
			`INSERT INTO ${t("transaction_status")} (transaction_id, status, posted_at)
       VALUES ($1, $2, NOW())`,
			[txnRecord.id, "posted"],
		);

		// FX params for cross-currency transfers
		const fxParams = isCrossCurrency
			? {
					originalAmount: amount,
					originalCurrency: srcCurrency,
					exchangeRate: resolvedExchangeRate,
				}
			: {};

		// Entry + balance updates for both accounts (skipLock: both already locked above)
		const dnFlag = ctx.options.advanced.useDenormalizedBalance;
		await Promise.all([
			insertEntryAndUpdateBalance({
				tx,
				transactionId: txnRecord.id,
				accountId: source.id,
				entryType: "DEBIT",
				amount,
				currency: srcCurrency,
				isHotAccount: false,
				skipLock: true,
				updateDenormalizedCache: dnFlag,
				...fxParams,
			}),
			insertEntryAndUpdateBalance({
				tx,
				transactionId: txnRecord.id,
				accountId: dest.id,
				entryType: "CREDIT",
				amount: creditAmount,
				currency: destCurrency,
				isHotAccount: false,
				skipLock: true,
				updateDenormalizedCache: dnFlag,
				...fxParams,
			}),
		]);

		const response = rawToTransactionResponse(
			{ ...txnRecord, status: "posted", posted_at: new Date() },
			"transfer",
			srcCurrency,
		);
		await batchTransactionSideEffects({
			tx,
			ctx,
			txnRecord,
			correlationId,
			reference,
			category,
			ledgerId,
			eventData: {
				reference,
				amount,
				source: sourceHolderId,
				destination: destinationHolderId,
				category,
			},
			outboxEvents: [
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
						type: "transfer",
					},
				},
				{
					topic: "ledger-account-credited",
					payload: {
						accountId: dest.id,
						holderId: destinationHolderId,
						holderType: dest.holder_type,
						amount,
						transactionId: txnRecord.id,
						reference,
						category,
						type: "transfer",
					},
				},
			],
			logEntries: [
				{ accountId: source.id, txnType: "debit", amount },
				{ accountId: dest.id, txnType: "credit", amount },
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
		/** Effective date for backdated transactions. Defaults to NOW(). */
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
			ctx.options.advanced.useDenormalizedBalance,
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

		// Create transaction record (IMMUTABLE — no status)
		const txnRecordRows = await tx.raw<RawTransactionRow>(
			`INSERT INTO ${t("transaction_record")} (type, reference, amount, currency, description, source_account_id, correlation_id, meta_data, ledger_id, effective_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10::timestamptz, NOW()))
       RETURNING *`,
			[
				"transfer",
				reference,
				amount,
				acctCurrency,
				description,
				source.id,
				correlationId,
				JSON.stringify({ ...metadata, category, destinations }),
				ledgerId,
				params.effectiveDate ?? null,
			],
		);
		const txnRecord = txnRecordRows[0];
		if (!txnRecord) throw SummaError.internal("Failed to insert multi-transfer transaction");

		// INSERT initial status (posted immediately, APPEND-ONLY)
		await tx.raw(
			`INSERT INTO ${t("transaction_status")} (transaction_id, status, posted_at)
       VALUES ($1, $2, NOW())`,
			[txnRecord.id, "posted"],
		);

		// DEBIT entry record for source (skipLock: already locked above)
		await insertEntryAndUpdateBalance({
			tx,
			transactionId: txnRecord.id,
			accountId: source.id,
			entryType: "DEBIT",
			amount,
			currency: acctCurrency,
			isHotAccount: false,
			skipLock: true,
			updateDenormalizedCache: ctx.options.advanced.useDenormalizedBalance,
		});

		// Credit all destinations
		const destResults = await creditMultiDestinations(tx, ctx, {
			transactionId: txnRecord.id,
			currency: acctCurrency,
			totalAmount: amount,
			destinations,
		});

		// Build dynamic outbox + log entries from destination results
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
		const logEntries: Array<{ accountId: string; txnType: "credit" | "debit"; amount: number }> = [
			{ accountId: source.id, txnType: "debit", amount },
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
			if (dest.accountId) {
				logEntries.push({ accountId: dest.accountId, txnType: "credit", amount: dest.amount });
			}
		}

		const response = rawToTransactionResponse(
			{ ...txnRecord, status: "posted", posted_at: new Date() },
			"transfer",
			acctCurrency,
		);
		await batchTransactionSideEffects({
			tx,
			ctx,
			txnRecord,
			correlationId,
			reference,
			category,
			ledgerId,
			eventData: {
				reference,
				amount,
				source: sourceHolderId,
				destinations: destinations.map((d) => d.holderId ?? d.systemAccount),
				category,
			},
			outboxEvents,
			logEntries,
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
	const rows = await ctx.readAdapter.raw<RawTransactionRow>(
		`${txnWithStatusSql(t)} WHERE tr.id = $1 AND tr.ledger_id = $2 LIMIT 1`,
		[transactionId, ledgerId],
	);

	const txn = rows[0];
	if (!txn) throw SummaError.notFound("Transaction not found");

	const type = inferTransactionType(txn);

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
		/** Opaque cursor for keyset pagination (faster than page/perPage at depth). */
		cursor?: string;
		/** Items per page when using cursor pagination. Default: 20, max: 100. */
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

	// First find the account (read-only — use replica)
	const accountRows = await ctx.readAdapter.raw<{ id: string }>(
		`SELECT id FROM ${t("account_balance")} WHERE holder_id = $1 AND ledger_id = $2 LIMIT 1`,
		[params.holderId, ledgerId],
	);

	if (!accountRows[0]) throw SummaError.notFound("Account not found");
	const accountId = accountRows[0].id;

	// Build common filter SQL fragments
	// NOTE: Filters on status use ts.status (from LATERAL JOIN), filters on other fields use tr.*
	const filterParts: string[] = [];
	const filterParams: unknown[] = [];
	let pIdx = 1;

	// We'll use $1 as accountId in all branches
	filterParams.push(accountId);
	pIdx++;

	if (params.status) {
		filterParts.push(`AND ts.status = $${pIdx++}`);
		filterParams.push(params.status);
	}
	if (params.category) {
		filterParts.push(`AND tr.meta_data->>'category' = $${pIdx++}`);
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

	// Helper: wrap a base query with LATERAL JOIN to transaction_status
	const withStatus = (baseWhere: string) =>
		`SELECT tr.*, ts.status, ts.committed_amount, ts.refunded_amount, ts.posted_at
     FROM ${t("transaction_record")} tr
     JOIN LATERAL (
       SELECT status, committed_amount, refunded_amount, posted_at
       FROM ${t("transaction_status")} WHERE transaction_id = tr.id
       ORDER BY created_at DESC LIMIT 1
     ) ts ON true
     WHERE ${baseWhere} ${commonFilters}`;

	// Build UNION ALL query based on type filter
	let unionQuery: string;
	if (params.type === "credit") {
		unionQuery = `
      ${withStatus(`tr.destination_account_id = $1 AND (tr.source_account_id IS NULL OR tr.source_account_id != $1)`)}
      UNION ALL
      SELECT tr2.*, ts2.status, ts2.committed_amount, ts2.refunded_amount, ts2.posted_at
      FROM ${t("transaction_record")} tr2
      JOIN ${t("entry_record")} er ON er.transaction_id = tr2.id
      JOIN LATERAL (
        SELECT status, committed_amount, refunded_amount, posted_at
        FROM ${t("transaction_status")} WHERE transaction_id = tr2.id
        ORDER BY created_at DESC LIMIT 1
      ) ts2 ON true
      WHERE er.account_id = $1
        AND er.entry_type = 'CREDIT'
        AND tr2.source_account_id IS NOT NULL
        AND tr2.destination_account_id IS NULL
        AND tr2.source_account_id != $1
        ${commonFilters.replace(/ts\./g, "ts2.").replace(/tr\./g, "tr2.")}
    `;
	} else if (params.type === "debit") {
		unionQuery = withStatus(`tr.source_account_id = $1`);
	} else if (params.type === "transfer") {
		unionQuery = `
      ${withStatus(`tr.source_account_id = $1 AND tr.destination_account_id IS NOT NULL`)}
      UNION ALL
      ${withStatus(`tr.destination_account_id = $1 AND tr.source_account_id IS NOT NULL AND tr.source_account_id != $1`)}
    `;
	} else {
		unionQuery = `
      ${withStatus(`tr.source_account_id = $1`)}
      UNION ALL
      ${withStatus(`tr.destination_account_id = $1 AND (tr.source_account_id IS NULL OR tr.source_account_id != $1)`)}
      UNION ALL
      SELECT tr2.*, ts2.status, ts2.committed_amount, ts2.refunded_amount, ts2.posted_at
      FROM ${t("transaction_record")} tr2
      JOIN ${t("entry_record")} er ON er.transaction_id = tr2.id
      JOIN LATERAL (
        SELECT status, committed_amount, refunded_amount, posted_at
        FROM ${t("transaction_status")} WHERE transaction_id = tr2.id
        ORDER BY created_at DESC LIMIT 1
      ) ts2 ON true
      WHERE er.account_id = $1
        AND er.entry_type = 'CREDIT'
        AND tr2.source_account_id IS NOT NULL
        AND tr2.destination_account_id IS NULL
        AND tr2.source_account_id != $1
        ${commonFilters.replace(/ts\./g, "ts2.").replace(/tr\./g, "tr2.")}
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
		// Keyset: filter in the outer wrapper (created_at DESC, id DESC)
		const cursorFilter = `WHERE (combined.created_at, combined.id) < ($${pIdx}::timestamptz, $${pIdx + 1})`;
		filterParams.push(cursorData.ca, cursorData.id);
		pIdx += 2;
		filterParams.push(perPage + 1);

		const rows = await ctx.readAdapter.raw<RawTransactionRow>(
			`SELECT * FROM (
           ${unionQuery}
         ) combined
         ${cursorFilter}
         ORDER BY combined.created_at DESC, combined.id DESC
         LIMIT $${pIdx}`,
			filterParams,
		);

		const hasMore = rows.length > perPage;
		const data = (hasMore ? rows.slice(0, perPage) : rows).map((txn) => {
			const type = inferTransactionType(txn);
			return rawToTransactionResponse(txn, type, txn.currency);
		});
		const lastRow = hasMore ? rows[perPage - 1] : undefined;
		const nextCursor = lastRow ? encodeCursor(lastRow.created_at, lastRow.id) : undefined;

		return { transactions: data, hasMore, total: -1, nextCursor };
	}

	// OFFSET/LIMIT pagination
	const page = Math.max(1, params.page ?? 1);
	const offset = (page - 1) * perPage;

	filterParams.push(perPage + 1);
	filterParams.push(offset);

	const rows = await ctx.readAdapter.raw<RawTransactionRow & { total_count: number }>(
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
		const type = inferTransactionType(txn);
		return rawToTransactionResponse(txn, type, txn.currency);
	});
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

		// Lock original transaction row + read latest status
		const originalRows = await tx.raw<RawTransactionRow>(
			`${txnWithStatusSql(t)} WHERE tr.id = $1 FOR UPDATE OF tr`,
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
			ledgerId,
		});
		if (idem.alreadyProcessed && isValidCachedResult(idem.cachedResult)) {
			return idem.cachedResult as LedgerTransaction;
		}

		const correlationId = randomUUID();

		// Update refunded_amount on original via new transaction_status row (APPEND-ONLY)
		const newRefundedAmount = alreadyRefunded + actualRefundAmount;
		const newStatus = newRefundedAmount >= originalAmount ? "reversed" : "posted";
		await tx.raw(
			`INSERT INTO ${t("transaction_status")} (transaction_id, status, refunded_amount, reason)
       VALUES ($1, $2, $3, $4)`,
			[transactionId, newStatus, newRefundedAmount, `Refund: ${reason}`],
		);

		// Create reversal transaction record (IMMUTABLE — no status)
		const reversalRows = await tx.raw<RawTransactionRow>(
			`INSERT INTO ${t("transaction_record")} (type, reference, amount, currency, description, source_account_id, destination_account_id, source_system_account_id, destination_system_account_id, parent_id, is_reversal, correlation_id, meta_data, ledger_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING *`,
			[
				"correction",
				refundReference,
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
				ledgerId,
			],
		);
		const reversal = reversalRows[0];
		if (!reversal) throw SummaError.internal("Failed to insert refund reversal");

		// INSERT initial status for reversal (posted immediately)
		await tx.raw(
			`INSERT INTO ${t("transaction_status")} (transaction_id, status, posted_at)
       VALUES ($1, $2, NOW())`,
			[reversal.id, "posted"],
		);

		// Reverse entries for user accounts (application-level balance update)
		if (original.destination_account_id) {
			await insertEntryAndUpdateBalance({
				tx,
				transactionId: reversal.id,
				accountId: original.destination_account_id,
				entryType: "DEBIT",
				amount: actualRefundAmount,
				currency: original.currency,
				isHotAccount: false,
				updateDenormalizedCache: ctx.options.advanced.useDenormalizedBalance,
			});
		}

		if (original.source_account_id) {
			await insertEntryAndUpdateBalance({
				tx,
				transactionId: reversal.id,
				accountId: original.source_account_id,
				entryType: "CREDIT",
				amount: actualRefundAmount,
				currency: original.currency,
				isHotAccount: false,
				updateDenormalizedCache: ctx.options.advanced.useDenormalizedBalance,
			});
		}

		// Reverse system account entries via hot account pattern
		if (original.source_system_account_id) {
			await Promise.all([
				insertHotAccountEntry(tx, ctx.options.schema, {
					systemAccountId: original.source_system_account_id,
					amount: actualRefundAmount,
					entryType: "CREDIT",
					transactionId: reversal.id,
				}),
				insertEntryAndUpdateBalance({
					tx,
					transactionId: reversal.id,
					systemAccountId: original.source_system_account_id,
					entryType: "CREDIT",
					amount: actualRefundAmount,
					currency: original.currency,
					isHotAccount: true,
				}),
			]);
		}

		if (original.destination_system_account_id) {
			await Promise.all([
				insertHotAccountEntry(tx, ctx.options.schema, {
					systemAccountId: original.destination_system_account_id,
					amount: actualRefundAmount,
					entryType: "DEBIT",
					transactionId: reversal.id,
				}),
				insertEntryAndUpdateBalance({
					tx,
					transactionId: reversal.id,
					systemAccountId: original.destination_system_account_id,
					entryType: "DEBIT",
					amount: actualRefundAmount,
					currency: original.currency,
					isHotAccount: true,
				}),
			]);
		}

		// Batch side effects: event store + outbox + velocity logs + idempotency
		const outboxEvents: Array<{ topic: string; payload: Record<string, unknown> }> = [];
		const logEntries: Array<{ accountId: string; txnType: "credit" | "debit"; amount: number }> =
			[];

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
			logEntries.push({
				accountId: original.destination_account_id,
				txnType: "debit",
				amount: actualRefundAmount,
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
			logEntries.push({
				accountId: original.source_account_id,
				txnType: "credit",
				amount: actualRefundAmount,
			});
		}

		const response = rawToTransactionResponse(
			{ ...reversal, status: "posted", posted_at: new Date() },
			"correction",
			original.currency,
		);
		await batchTransactionSideEffects({
			tx,
			ctx,
			txnRecord: reversal,
			correlationId,
			reference: reversal.reference,
			category: "refund",
			ledgerId,
			eventType: TRANSACTION_EVENTS.REVERSED,
			eventAggregateId: original.id,
			eventData: {
				reversalId: reversal.id,
				reason,
				amount: actualRefundAmount,
				refundedSoFar: newRefundedAmount,
				fullyRefunded: newStatus === "reversed",
			},
			outboxEvents,
			logEntries,
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

/** Read the transaction type from the stored `type` column. */
function inferTransactionType(txn: RawTransactionRow): TransactionType {
	return (txn.type ?? "credit") as TransactionType;
}
