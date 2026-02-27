// =============================================================================
// BATCH ENGINE PLUGIN — TigerBeetle-inspired Transaction Batching (v2)
// =============================================================================
// Instead of 1 DB transaction per API request, buffers N requests and processes
// them in a single DB transaction using multi-row UNNEST INSERTs.
//
// This amortizes lock acquisition, round-trip latency, and commit overhead
// across N transactions, enabling 10,000-20,000+ TPS while keeping ALL
// security guarantees (HMAC hash chains, balance checksums, immutable entries)
// fully intact.
//
// Each buffered transaction gets its own resolve/reject Promise, so callers
// see the same API surface as non-batched mode.
//
// v2 schema changes:
// - transfer (replaces transaction_record + transaction_status)
// - entry (replaces entry_record, hot_account_entry, ledger_event, account_transaction_log)
// - account UPDATE (replaces account_balance_version INSERT + denormalized cache UPDATE)
// - Removed: hot_account_entry, ledger_event, account_transaction_log, account_balance_version

import { randomUUID } from "node:crypto";
import type { LedgerTransaction, SummaContext, SummaPlugin } from "@summa-ledger/core";
import { computeBalanceChecksum, computeHash, validatePluginOptions } from "@summa-ledger/core";
import { createTableResolver } from "@summa-ledger/core/db";
import { withTransactionTimeout } from "../infrastructure/event-store.js";
import { resolveAccountForUpdate } from "../managers/account-manager.js";
import { checkSufficientBalance } from "../managers/balance-check.js";
import { checkIdempotencyKeyInTx, isValidCachedResult } from "../managers/idempotency.js";
import { enforceLimitsWithAccountId } from "../managers/limit-manager.js";
import type { RawAccountRow, RawTransferRow } from "../managers/raw-types.js";
import { rawToTransactionResponse } from "../managers/sql-helpers.js";
import {
	assertAccountActive,
	resolveSystemAccountInTx,
	validateAmount,
} from "../managers/transaction-helpers.js";

// =============================================================================
// OPTIONS
// =============================================================================

export interface BatchEngineOptions {
	/** Maximum number of transactions per batch. Default: 200 */
	maxBatchSize?: number;
	/** Maximum time to wait before flushing an incomplete batch (ms). Default: 5 */
	flushIntervalMs?: number;
}

// =============================================================================
// TYPES
// =============================================================================

export interface BatchableTransaction {
	type: "credit" | "debit";
	holderId: string;
	amount: number;
	reference: string;
	description: string;
	category: string;
	metadata: Record<string, unknown>;
	/** System account identifier (e.g., "@World") */
	systemAccount: string;
	/** @deprecated Ignored — overdraft is now controlled only at account level via allowOverdraft + overdraftLimit */
	allowOverdraft?: boolean;
	/**
	 * TigerBeetle-inspired balancing flag. When true for debits, the amount is
	 * capped to available balance instead of failing with INSUFFICIENT_BALANCE.
	 */
	balancing?: boolean;
	idempotencyKey?: string;
	resolve: (result: LedgerTransaction) => void;
	reject: (error: Error) => void;
}

// Internal representation after account resolution
interface ResolvedBatchItem {
	item: BatchableTransaction;
	account: RawAccountRow;
	systemAccountId: string;
	transferId: string;
	correlationId: string;
	balanceBefore: number;
	balanceAfter: number;
	newVersion: number;
	newCreditBalance: number;
	newDebitBalance: number;
	checksum: string;
}

// =============================================================================
// BATCH ENGINE CLASS
// =============================================================================

export class TransactionBatchEngine {
	private buffer: BatchableTransaction[] = [];
	private flushTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly maxBatchSize: number;
	private readonly flushIntervalMs: number;

	constructor(
		private readonly ctx: SummaContext,
		options: BatchEngineOptions,
	) {
		this.maxBatchSize = options.maxBatchSize ?? 200;
		this.flushIntervalMs = options.flushIntervalMs ?? 5;
	}

	/**
	 * Submit a transaction to the batch buffer.
	 * Returns a Promise that resolves when the batch containing this transaction is processed.
	 */
	submit(params: Omit<BatchableTransaction, "resolve" | "reject">): Promise<LedgerTransaction> {
		return new Promise<LedgerTransaction>((resolve, reject) => {
			this.buffer.push({ ...params, resolve, reject });

			if (this.buffer.length >= this.maxBatchSize) {
				this.flushNow();
			} else if (!this.flushTimer) {
				this.flushTimer = setTimeout(() => this.flushNow(), this.flushIntervalMs);
			}
		});
	}

	/**
	 * Force-flush any pending transactions. Useful for graceful shutdown.
	 */
	async flush(): Promise<void> {
		if (this.buffer.length > 0) {
			await this.flushNow();
		}
	}

	/**
	 * Shut down the engine, flushing remaining transactions.
	 */
	async shutdown(): Promise<void> {
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
		await this.flush();
	}

	private async flushNow(): Promise<void> {
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}

		if (this.buffer.length === 0) return;

		const batch = this.buffer.splice(0, this.maxBatchSize);

		// If there are still items in the buffer, schedule next flush
		if (this.buffer.length > 0) {
			this.flushTimer = setTimeout(() => this.flushNow(), this.flushIntervalMs);
		}

		try {
			await this.processBatch(batch);
		} catch (err) {
			// If the entire batch fails (DB error), reject all transactions
			const error = err instanceof Error ? err : new Error(String(err));
			for (const item of batch) {
				item.reject(error);
			}
		}
	}

	// ===========================================================================
	// BATCH PROCESSING — v2 schema (5 writes instead of ~10)
	//
	// 1. transfer INSERT (replaces transaction_record + transaction_status)
	// 2. entry INSERT — user account side (with hash chain fields)
	// 3. entry INSERT — system account side (with hash chain fields)
	// 4. account UPDATE — user accounts (balance + version + checksum)
	// 5. outbox INSERT
	// 6. (optional) idempotency_key INSERT
	// ===========================================================================

	private async processBatch(batch: BatchableTransaction[]): Promise<void> {
		const ctx = this.ctx;
		const schema = ctx.options.schema;
		const ledgerId = ctx.ledgerId;
		const hmacSecret = ctx.options.advanced.hmacSecret;

		await withTransactionTimeout(ctx, async (tx) => {
			const t = createTableResolver(schema);

			// 1. Pre-validate amounts
			for (const item of batch) {
				try {
					validateAmount(item.amount, ctx.options.advanced.maxTransactionAmount);
				} catch (err) {
					item.reject(err instanceof Error ? err : new Error(String(err)));
				}
			}
			const validAfterAmount = batch.filter((item) => !(item as { _rejected?: boolean })._rejected);

			// 2. Idempotency checks — batch them
			const needsIdem = validAfterAmount.filter((item) => item.idempotencyKey);
			const idemResults = new Map<string, LedgerTransaction | null>();
			for (const item of needsIdem) {
				try {
					const idem = await checkIdempotencyKeyInTx(tx, {
						idempotencyKey: item.idempotencyKey,
						reference: item.reference,
						ledgerId,
					});
					if (idem.alreadyProcessed && isValidCachedResult(idem.cachedResult)) {
						item.resolve(idem.cachedResult as LedgerTransaction);
						idemResults.set(item.reference, idem.cachedResult as LedgerTransaction);
					}
				} catch (err) {
					item.reject(err instanceof Error ? err : new Error(String(err)));
				}
			}

			// Filter out already-resolved idempotent transactions
			const remaining = validAfterAmount.filter((item) => !idemResults.has(item.reference));

			if (remaining.length === 0) return;

			// 3. Collect unique holder IDs and resolve accounts
			const uniqueHolders = [...new Set(remaining.map((item) => item.holderId))];

			// Sort holder IDs for deterministic lock ordering (prevents deadlocks)
			uniqueHolders.sort();

			// Lock and read all accounts in deterministic order
			const accountMap = new Map<string, RawAccountRow>();
			for (const holderId of uniqueHolders) {
				try {
					const account = await resolveAccountForUpdate(
						tx,
						ledgerId,
						holderId,
						schema,
						ctx.options.advanced.lockMode,
					);
					accountMap.set(holderId, account);
				} catch (err) {
					// Reject all items for this holder
					for (const item of remaining.filter((i) => i.holderId === holderId)) {
						item.reject(err instanceof Error ? err : new Error(String(err)));
					}
				}
			}

			// 4. Validate and resolve each transaction
			const valid: ResolvedBatchItem[] = [];

			// Track cumulative balance changes per account within this batch
			const balanceDeltas = new Map<
				string,
				{
					balance: number;
					version: number;
					creditBalance: number;
					debitBalance: number;
				}
			>();

			// Resolve system accounts (cached, no DB hit after first call)
			const systemAccountMap = new Map<string, string>();

			for (const item of remaining) {
				const account = accountMap.get(item.holderId);
				if (!account) continue; // Already rejected above

				try {
					assertAccountActive(account);

					// Enforce limits
					await enforceLimitsWithAccountId(tx, {
						accountId: account.id,
						holderId: item.holderId,
						amount: item.amount,
						txnType: item.type,
						category: item.category,
					});

					// Get cumulative delta for this account
					const delta = balanceDeltas.get(account.id) ?? {
						balance: Number(account.balance),
						version: Number(account.version),
						creditBalance: Number(account.credit_balance),
						debitBalance: Number(account.debit_balance),
					};

					// Balancing debit (TigerBeetle-inspired): cap amount to available balance
					let actualAmount = item.amount;
					if (item.type === "debit" && item.balancing) {
						const avail = delta.balance - Number(account.pending_debit);
						actualAmount = Math.min(item.amount, Math.max(0, avail));
					}

					// Compute new balance
					const balanceBefore = delta.balance;
					const balanceAfter =
						item.type === "credit" ? balanceBefore + actualAmount : balanceBefore - actualAmount;

					// Check sufficient balance for debits (account-level only)
					if (item.type === "debit" && !item.balancing) {
						const availableBalance = balanceBefore - Number(account.pending_debit);
						try {
							checkSufficientBalance({
								available: availableBalance,
								amount: actualAmount,
								allowOverdraft: account.allow_overdraft,
								overdraftLimit: Number(account.overdraft_limit ?? 0),
							});
						} catch (err) {
							item.reject(err as Error);
							continue;
						}
					}

					const newVersion = delta.version + 1;
					const newCreditBalance =
						item.type === "credit" ? delta.creditBalance + actualAmount : delta.creditBalance;
					const newDebitBalance =
						item.type === "debit" ? delta.debitBalance + actualAmount : delta.debitBalance;

					// Update cumulative delta
					balanceDeltas.set(account.id, {
						balance: balanceAfter,
						version: newVersion,
						creditBalance: newCreditBalance,
						debitBalance: newDebitBalance,
					});

					// Pre-compute checksum
					const checksum = computeBalanceChecksum(
						{
							balance: balanceAfter,
							creditBalance: newCreditBalance,
							debitBalance: newDebitBalance,
							pendingDebit: Number(account.pending_debit),
							pendingCredit: Number(account.pending_credit),
							lockVersion: newVersion,
						},
						hmacSecret,
					);

					// Resolve system account
					let sysAcctId = systemAccountMap.get(item.systemAccount);
					if (!sysAcctId) {
						sysAcctId = await resolveSystemAccountInTx(tx, item.systemAccount, schema, ledgerId);
						systemAccountMap.set(item.systemAccount, sysAcctId);
					}
					const resolvedSystemAccountId: string = sysAcctId;

					const transferId = randomUUID();
					const correlationId = randomUUID();

					valid.push({
						item,
						account,
						systemAccountId: resolvedSystemAccountId,
						transferId,
						correlationId,
						balanceBefore,
						balanceAfter,
						newVersion,
						newCreditBalance,
						newDebitBalance,
						checksum,
					});
				} catch (err) {
					item.reject(err instanceof Error ? err : new Error(String(err)));
				}
			}

			if (valid.length === 0) return;

			// 5. Multi-row INSERT/UPDATE using UNNEST arrays
			// v2 flow: ~5 writes instead of ~10

			const now = new Date();
			const nowIso = now.toISOString();

			// --- transfer INSERT (replaces transaction_record + transaction_status) ---
			const txnIds: string[] = [];
			const txnTypes: string[] = [];
			const txnRefs: string[] = [];
			const txnAmounts: number[] = [];
			const txnCurrencies: string[] = [];
			const txnDescriptions: string[] = [];
			const txnSourceAccounts: (string | null)[] = [];
			const txnDestAccounts: (string | null)[] = [];
			const txnCorrelationIds: string[] = [];
			const txnMetadata: string[] = [];
			const txnLedgerIds: string[] = [];
			const txnStatuses: string[] = [];
			const txnPostedAts: string[] = [];

			for (const v of valid) {
				txnIds.push(v.transferId);
				txnTypes.push(v.item.type);
				txnRefs.push(v.item.reference);
				txnAmounts.push(v.item.amount);
				txnCurrencies.push(v.account.currency);
				txnDescriptions.push(v.item.description);
				txnSourceAccounts.push(v.item.type === "debit" ? v.account.id : null);
				txnDestAccounts.push(v.item.type === "credit" ? v.account.id : null);
				txnCorrelationIds.push(v.correlationId);
				txnMetadata.push(JSON.stringify({ ...v.item.metadata, category: v.item.category }));
				txnLedgerIds.push(ledgerId);
				txnStatuses.push("posted");
				txnPostedAts.push(nowIso);
			}

			await tx.raw(
				`INSERT INTO ${t("transfer")} (
					id, type, reference, amount, currency, description,
					source_account_id, destination_account_id,
					correlation_id, metadata, ledger_id, status, posted_at
				)
				SELECT * FROM UNNEST(
					$1::uuid[], $2::text[], $3::text[], $4::bigint[], $5::text[], $6::text[],
					$7::uuid[], $8::uuid[],
					$9::uuid[], $10::jsonb[], $11::text[], $12::text[], $13::timestamptz[]
				)`,
				[
					txnIds,
					txnTypes,
					txnRefs,
					txnAmounts,
					txnCurrencies,
					txnDescriptions,
					txnSourceAccounts,
					txnDestAccounts,
					txnCorrelationIds,
					txnMetadata,
					txnLedgerIds,
					txnStatuses,
					txnPostedAts,
				],
			);

			// --- entry INSERT (user account side — with hash chain fields) ---
			// Fetch prev_hash per account for hash chain continuity
			const uniqueAccountIds = [...new Set(valid.map((v) => v.account.id))];
			const prevHashMap = new Map<string, string | null>();

			if (uniqueAccountIds.length > 0) {
				const prevRows = await tx.raw<{ account_id: string; hash: string }>(
					`SELECT DISTINCT ON (account_id) account_id, hash
					 FROM ${t("entry")}
					 WHERE account_id = ANY($1::uuid[])
					 ORDER BY account_id, sequence_number DESC`,
					[uniqueAccountIds],
				);
				for (const row of prevRows) {
					prevHashMap.set(row.account_id, row.hash);
				}
			}

			// Also fetch prev_hash for system accounts
			const uniqueSystemAccountIds = [...new Set(valid.map((v) => v.systemAccountId))];
			if (uniqueSystemAccountIds.length > 0) {
				const prevRows = await tx.raw<{ account_id: string; hash: string }>(
					`SELECT DISTINCT ON (account_id) account_id, hash
					 FROM ${t("entry")}
					 WHERE account_id = ANY($1::uuid[])
					 ORDER BY account_id, sequence_number DESC`,
					[uniqueSystemAccountIds],
				);
				for (const row of prevRows) {
					prevHashMap.set(row.account_id, row.hash);
				}
			}

			// Track per-account chain state (hash evolves as we add entries within the batch)
			const chainState = new Map<string, string | null>();

			const userEntryTransferIds: string[] = [];
			const userEntryAccountIds: string[] = [];
			const userEntryTypes: string[] = [];
			const userEntryAmounts: number[] = [];
			const userEntryCurrencies: string[] = [];
			const userEntryBBs: (number | null)[] = [];
			const userEntryBAs: (number | null)[] = [];
			const userEntryVersions: (number | null)[] = [];
			const userEntryHashes: string[] = [];
			const userEntryPrevHashes: (string | null)[] = [];

			for (const v of valid) {
				const accountId = v.account.id;
				const prevHash = chainState.get(accountId) ?? prevHashMap.get(accountId) ?? null;

				const entryData = {
					transferId: v.transferId,
					accountId,
					entryType: v.item.type === "credit" ? "CREDIT" : "DEBIT",
					amount: v.item.amount,
					currency: v.account.currency,
					balanceBefore: v.balanceBefore,
					balanceAfter: v.balanceAfter,
					version: v.newVersion,
				};
				const hash = computeHash(prevHash, entryData, hmacSecret);
				chainState.set(accountId, hash);

				userEntryTransferIds.push(v.transferId);
				userEntryAccountIds.push(accountId);
				userEntryTypes.push(v.item.type === "credit" ? "CREDIT" : "DEBIT");
				userEntryAmounts.push(v.item.amount);
				userEntryCurrencies.push(v.account.currency);
				userEntryBBs.push(v.balanceBefore);
				userEntryBAs.push(v.balanceAfter);
				userEntryVersions.push(v.newVersion);
				userEntryHashes.push(hash);
				userEntryPrevHashes.push(prevHash);
			}

			await tx.raw(
				`INSERT INTO ${t("entry")} (
					transfer_id, account_id, entry_type, amount, currency,
					balance_before, balance_after, account_version,
					sequence_number, hash, prev_hash, effective_date
				)
				SELECT
					t.transfer_id, t.account_id, t.entry_type, t.amount, t.currency,
					t.balance_before, t.balance_after, t.account_version,
					nextval('${t("entry")}_sequence_number_seq'), t.hash, t.prev_hash, NOW()
				FROM UNNEST(
					$1::uuid[], $2::uuid[], $3::text[], $4::bigint[], $5::text[],
					$6::bigint[], $7::bigint[], $8::int[],
					$9::text[], $10::text[]
				) AS t(transfer_id, account_id, entry_type, amount, currency,
					balance_before, balance_after, account_version,
					hash, prev_hash)`,
				[
					userEntryTransferIds,
					userEntryAccountIds,
					userEntryTypes,
					userEntryAmounts,
					userEntryCurrencies,
					userEntryBBs,
					userEntryBAs,
					userEntryVersions,
					userEntryHashes,
					userEntryPrevHashes,
				],
			);

			// --- entry INSERT (system/hot account side — with hash chain, no balance) ---
			const sysEntryTransferIds: string[] = [];
			const sysEntryAccountIds: string[] = [];
			const sysEntryTypes: string[] = [];
			const sysEntryAmounts: number[] = [];
			const sysEntryCurrencies: string[] = [];
			const sysEntryHashes: string[] = [];
			const sysEntryPrevHashes: (string | null)[] = [];

			for (const v of valid) {
				const systemAccountId = v.systemAccountId;
				const prevHash = chainState.get(systemAccountId) ?? prevHashMap.get(systemAccountId) ?? null;

				const entryType = v.item.type === "credit" ? "DEBIT" : "CREDIT";
				const entryData = {
					transferId: v.transferId,
					accountId: systemAccountId,
					entryType,
					amount: v.item.amount,
					currency: v.account.currency,
					isHot: true,
				};
				const hash = computeHash(prevHash, entryData, hmacSecret);
				chainState.set(systemAccountId, hash);

				sysEntryTransferIds.push(v.transferId);
				sysEntryAccountIds.push(systemAccountId);
				sysEntryTypes.push(entryType);
				sysEntryAmounts.push(v.item.amount);
				sysEntryCurrencies.push(v.account.currency);
				sysEntryHashes.push(hash);
				sysEntryPrevHashes.push(prevHash);
			}

			await tx.raw(
				`INSERT INTO ${t("entry")} (
					transfer_id, account_id, entry_type, amount, currency,
					sequence_number, hash, prev_hash, effective_date
				)
				SELECT
					t.transfer_id, t.account_id, t.entry_type, t.amount, t.currency,
					nextval('${t("entry")}_sequence_number_seq'), t.hash, t.prev_hash, NOW()
				FROM UNNEST(
					$1::uuid[], $2::uuid[], $3::text[], $4::bigint[], $5::text[],
					$6::text[], $7::text[]
				) AS t(transfer_id, account_id, entry_type, amount, currency,
					hash, prev_hash)`,
				[
					sysEntryTransferIds,
					sysEntryAccountIds,
					sysEntryTypes,
					sysEntryAmounts,
					sysEntryCurrencies,
					sysEntryHashes,
					sysEntryPrevHashes,
				],
			);

			// --- account UPDATE (direct balance mutation — replaces account_balance_version + cache) ---
			// Collect the FINAL state per account (not per-transaction)
			const accountUpdates = new Map<
				string,
				{
					balance: number;
					creditBalance: number;
					debitBalance: number;
					version: number;
					checksum: string;
				}
			>();

			for (const v of valid) {
				// Always keep the last (highest version) state per account
				const existing = accountUpdates.get(v.account.id);
				if (!existing || v.newVersion > existing.version) {
					accountUpdates.set(v.account.id, {
						balance: v.balanceAfter,
						creditBalance: v.newCreditBalance,
						debitBalance: v.newDebitBalance,
						version: v.newVersion,
						checksum: v.checksum,
					});
				}
			}

			const updAccIds: string[] = [];
			const updBals: number[] = [];
			const updCBals: number[] = [];
			const updDBals: number[] = [];
			const updVers: number[] = [];
			const updChks: string[] = [];

			for (const [id, data] of accountUpdates) {
				updAccIds.push(id);
				updBals.push(data.balance);
				updCBals.push(data.creditBalance);
				updDBals.push(data.debitBalance);
				updVers.push(data.version);
				updChks.push(data.checksum);
			}

			await tx.raw(
				`UPDATE ${t("account")} SET
					balance = v.balance,
					credit_balance = v.credit_balance,
					debit_balance = v.debit_balance,
					version = v.version,
					checksum = v.checksum
				FROM (
					SELECT * FROM UNNEST(
						$1::uuid[], $2::bigint[], $3::bigint[], $4::bigint[],
						$5::int[], $6::text[]
					) AS t(id, balance, credit_balance, debit_balance, version, checksum)
				) AS v
				WHERE ${t("account")}.id = v.id`,
				[updAccIds, updBals, updCBals, updDBals, updVers, updChks],
			);

			// --- outbox INSERT ---
			const outboxTopics: string[] = [];
			const outboxPayloads: string[] = [];

			for (const v of valid) {
				const topic =
					v.item.type === "credit" ? "ledger-account-credited" : "ledger-account-debited";
				outboxTopics.push(topic);
				outboxPayloads.push(
					JSON.stringify({
						accountId: v.account.id,
						holderId: v.item.holderId,
						holderType: v.account.holder_type,
						amount: v.item.amount,
						transferId: v.transferId,
						reference: v.item.reference,
						category: v.item.category,
					}),
				);
			}

			await tx.raw(
				`INSERT INTO ${t("outbox")} (topic, payload)
				SELECT * FROM UNNEST($1::text[], $2::jsonb[])`,
				[outboxTopics, outboxPayloads],
			);

			// --- idempotency keys (only for items that have them) ---
			const idemItems = valid.filter((v) => v.item.idempotencyKey);
			if (idemItems.length > 0) {
				const idemLedgerIds: string[] = [];
				const idemKeys: string[] = [];
				const idemRefs: string[] = [];
				const idemResultData: string[] = [];
				const ttl = Math.ceil((ctx.options.advanced.idempotencyTTL ?? 86_400_000) / 1000);

				for (const v of idemItems) {
					idemLedgerIds.push(ledgerId);
					idemKeys.push(v.item.idempotencyKey!);
					idemRefs.push(v.item.reference);
					idemResultData.push("null"); // Will be updated if needed
				}

				await tx.raw(
					`INSERT INTO ${t("idempotency_key")} (ledger_id, key, reference, result_data, expires_at)
					SELECT lid, k, ref, rd::jsonb, NOW() + INTERVAL '1 second' * ${ttl}
					FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[])
					AS t(lid, k, ref, rd)
					ON CONFLICT (ledger_id, key) DO UPDATE
					SET result_data = EXCLUDED.result_data,
						reference = EXCLUDED.reference,
						expires_at = EXCLUDED.expires_at`,
					[idemLedgerIds, idemKeys, idemRefs, idemResultData],
				);
			}

			// 6. Resolve all promises with response objects
			for (const v of valid) {
				const fullMetadata = {
					...v.item.metadata,
					category: v.item.category,
				};

				const response: LedgerTransaction = rawToTransactionResponse(
					{
						id: v.transferId,
						ledger_id: ledgerId,
						reference: v.item.reference,
						amount: v.item.amount,
						currency: v.account.currency,
						description: v.item.description,
						source_account_id: v.item.type === "debit" ? v.account.id : null,
						destination_account_id: v.item.type === "credit" ? v.account.id : null,
						correlation_id: v.correlationId,
						is_reversal: false,
						is_hold: false,
						parent_id: null,
						metadata: fullMetadata,
						created_at: now,
						effective_date: now,
						status: "posted",
						posted_at: now,
						committed_amount: null,
						refunded_amount: 0,
						hold_expires_at: null,
						type: v.item.type,
					} as RawTransferRow,
					v.item.type,
					v.account.currency,
				);

				v.item.resolve(response);
			}
		});
	}
}

// =============================================================================
// PLUGIN FACTORY
// =============================================================================

export function batchEngine(options?: BatchEngineOptions): SummaPlugin {
	const opts = validatePluginOptions<BatchEngineOptions>("batch-engine", options, {
		maxBatchSize: { type: "number", default: 200 },
		flushIntervalMs: { type: "number", default: 5 },
	});

	let engine: TransactionBatchEngine | null = null;

	return {
		id: "batch-engine",

		$Infer: {} as {
			BatchEngine: TransactionBatchEngine;
			BatchEngineOptions: BatchEngineOptions;
		},

		init(ctx: SummaContext) {
			engine = new TransactionBatchEngine(ctx, opts);
			// Expose engine on context for transaction-manager to use
			(ctx as SummaContext & { batchEngine?: TransactionBatchEngine }).batchEngine = engine;
		},

		workers: [
			{
				id: "batch-engine-shutdown",
				description: "Flushes remaining batched transactions on shutdown",
				handler: async () => {
					if (engine) {
						await engine.shutdown();
					}
				},
				interval: "0s", // Not a polling worker — called manually on shutdown
			},
		],
	};
}
