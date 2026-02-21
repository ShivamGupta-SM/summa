// =============================================================================
// SUMMA -- Main entry point
// =============================================================================
// Creates the Summa instance that provides the full ledger API.

import type {
	Account,
	AccountBalance,
	AccountStatus,
	AccountType,
	Hold,
	HoldDestination,
	HolderType,
	InferPluginTypes,
	JournalEntryLeg,
	LedgerTransaction,
	MerkleProof,
	StoredEvent,
	SummaContext,
	SummaOptions,
	SummaPlugin,
	TransactionStatus,
	TransactionType,
} from "@summa/core";
import { buildContext } from "../context/context.js";
import * as events from "../infrastructure/event-store.js";
import * as hashChain from "../infrastructure/hash-chain.js";
import { createWorkerRunner, type SummaWorkerRunner } from "../infrastructure/worker-runner.js";
import * as accounts from "../managers/account-manager.js";
import {
	type AccountingEquationResult,
	type AccountNode,
	getAccountHierarchy,
	getAccountsByType,
	getChildAccounts,
	validateAccountingEquation,
} from "../managers/chart-of-accounts.js";
import * as corrections from "../managers/correction-manager.js";
import * as holds from "../managers/hold-manager.js";
import * as journal from "../managers/journal-manager.js";
import type { AccountLimitInfo, LimitType } from "../managers/limit-manager.js";
import * as limits from "../managers/limit-manager.js";
import { initializeSystemAccounts } from "../managers/system-accounts.js";
import * as transactions from "../managers/transaction-manager.js";

// =============================================================================
// SUMMA INTERFACE
// =============================================================================

export interface Summa<TInfer = Record<string, never>> {
	accounts: {
		create: (params: {
			holderId: string;
			holderType: HolderType;
			currency?: string;
			allowOverdraft?: boolean;
			indicator?: string;
			accountType?: AccountType;
			accountCode?: string;
			parentAccountId?: string;
			metadata?: Record<string, unknown>;
		}) => Promise<Account>;
		get: (holderId: string) => Promise<Account>;
		getById: (accountId: string) => Promise<Account>;
		getBalance: (holderId: string) => Promise<AccountBalance>;
		freeze: (params: { holderId: string; reason: string; frozenBy: string }) => Promise<Account>;
		unfreeze: (params: {
			holderId: string;
			unfrozenBy: string;
			reason?: string;
		}) => Promise<Account>;
		close: (params: {
			holderId: string;
			closedBy: string;
			reason?: string;
			transferToHolderId?: string;
		}) => Promise<Account>;
		list: (params: {
			page?: number;
			perPage?: number;
			status?: AccountStatus;
			holderType?: HolderType;
			search?: string;
		}) => Promise<{ accounts: Account[]; hasMore: boolean; total: number }>;
	};
	chartOfAccounts: {
		getByType: (accountType: AccountType) => Promise<Account[]>;
		getChildren: (parentAccountId: string) => Promise<Account[]>;
		getHierarchy: (rootAccountId?: string) => Promise<AccountNode[]>;
		validateEquation: () => Promise<AccountingEquationResult>;
	};
	transactions: {
		credit: (params: {
			holderId: string;
			amount: number;
			reference: string;
			description?: string;
			category?: string;
			metadata?: Record<string, unknown>;
			sourceSystemAccount?: string;
			idempotencyKey?: string;
		}) => Promise<LedgerTransaction>;
		debit: (params: {
			holderId: string;
			amount: number;
			reference: string;
			description?: string;
			category?: string;
			metadata?: Record<string, unknown>;
			destinationSystemAccount?: string;
			allowOverdraft?: boolean;
			idempotencyKey?: string;
		}) => Promise<LedgerTransaction>;
		transfer: (params: {
			sourceHolderId: string;
			destinationHolderId: string;
			amount: number;
			reference: string;
			description?: string;
			category?: string;
			metadata?: Record<string, unknown>;
			idempotencyKey?: string;
			/** Exchange rate as scaled integer (rate × 1_000_000). Auto-resolved if fx-engine plugin is registered. */
			exchangeRate?: number;
		}) => Promise<LedgerTransaction>;
		multiTransfer: (params: {
			sourceHolderId: string;
			amount: number;
			destinations: HoldDestination[];
			reference: string;
			description?: string;
			category?: string;
			metadata?: Record<string, unknown>;
			idempotencyKey?: string;
		}) => Promise<LedgerTransaction>;
		refund: (params: {
			transactionId: string;
			reason: string;
			amount?: number;
			idempotencyKey?: string;
		}) => Promise<LedgerTransaction>;
		correct: (params: {
			transactionId: string;
			correctionEntries: JournalEntryLeg[];
			reason: string;
			reference?: string;
			idempotencyKey?: string;
		}) => Promise<{ reversal: LedgerTransaction; correction: LedgerTransaction }>;
		adjust: (params: {
			entries: JournalEntryLeg[];
			reference: string;
			adjustmentType: "accrual" | "depreciation" | "correction" | "reclassification";
			description?: string;
			metadata?: Record<string, unknown>;
			idempotencyKey?: string;
		}) => Promise<LedgerTransaction>;
		journal: (params: {
			entries: JournalEntryLeg[];
			reference: string;
			description?: string;
			metadata?: Record<string, unknown>;
			idempotencyKey?: string;
		}) => Promise<LedgerTransaction>;
		get: (id: string) => Promise<LedgerTransaction>;
		list: (params: {
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
		}) => Promise<{
			transactions: LedgerTransaction[];
			hasMore: boolean;
			total: number;
		}>;
	};
	holds: {
		create: (params: {
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
		}) => Promise<Hold>;
		createMultiDestination: (params: {
			holderId: string;
			amount: number;
			reference: string;
			description?: string;
			category?: string;
			destinations: HoldDestination[];
			expiresInMinutes?: number;
			metadata?: Record<string, unknown>;
			idempotencyKey?: string;
		}) => Promise<Hold>;
		/** @deprecated Use `createMultiDestination` instead */
		createMultiDest: (params: {
			holderId: string;
			amount: number;
			reference: string;
			description?: string;
			category?: string;
			destinations: HoldDestination[];
			expiresInMinutes?: number;
			metadata?: Record<string, unknown>;
			idempotencyKey?: string;
		}) => Promise<Hold>;
		commit: (params: {
			holdId: string;
			amount?: number;
		}) => Promise<{ holdId: string; committedAmount: number; originalAmount: number }>;
		void: (params: {
			holdId: string;
			reason?: string;
		}) => Promise<{ holdId: string; amount: number }>;
		expireAll: () => Promise<{ expired: number }>;
		get: (id: string) => Promise<Hold>;
		listActive: (params: {
			holderId: string;
			page?: number;
			perPage?: number;
			category?: string;
		}) => Promise<{ holds: Hold[]; hasMore: boolean; total: number }>;
		listAll: (params: {
			holderId: string;
			page?: number;
			perPage?: number;
			category?: string;
			status?: "inflight" | "posted" | "voided" | "expired";
		}) => Promise<{ holds: Hold[]; hasMore: boolean; total: number }>;
	};
	events: {
		getForAggregate: (type: string, id: string) => Promise<StoredEvent[]>;
		getByCorrelation: (correlationId: string) => Promise<StoredEvent[]>;
		verifyChain: (
			type: string,
			id: string,
		) => Promise<{ valid: boolean; brokenAtVersion?: number; eventCount: number }>;
		verifyExternalAnchor: (
			blockSequence: number,
			externalBlockHash: string,
		) => Promise<{ valid: boolean; storedHash: string; merkleRoot: string | null }>;
		/** Generate a Merkle proof for a specific event (O(log n) siblings). */
		generateProof: (
			eventId: string,
		) => Promise<MerkleProof & { blockId: string; blockSequence: number }>;
		/** Verify a Merkle proof, optionally cross-checking against the stored block root. */
		verifyProof: (
			proof: MerkleProof,
			blockId?: string,
		) => Promise<{ valid: boolean; rootMatch: boolean }>;
	};
	limits: {
		set: (params: {
			holderId: string;
			limitType: LimitType;
			maxAmount: number;
			category?: string;
			enabled?: boolean;
		}) => Promise<AccountLimitInfo>;
		get: (holderId: string) => Promise<AccountLimitInfo[]>;
		remove: (params: {
			holderId: string;
			limitType: LimitType;
			category?: string;
		}) => Promise<void>;
		getUsage: (params: {
			holderId: string;
			txnType?: "credit" | "debit" | "hold";
			category?: string;
		}) => Promise<{ daily: number; monthly: number }>;
	};
	workers: {
		/** Start all plugin background workers */
		start: () => Promise<void>;
		/** Stop all plugin background workers and release leases */
		stop: () => Promise<void>;
	};
	$context: Promise<SummaContext>;
	$options: SummaOptions;
	/** Type inference from plugins — type-only, runtime value is empty object */
	$Infer: TInfer;
}

/**
 * Summa instance with inferred plugin types.
 */
export type SummaInstance<TPlugins extends readonly SummaPlugin[] = SummaPlugin[]> = Summa<
	InferPluginTypes<TPlugins>
>;

// =============================================================================
// CREATE SUMMA
// =============================================================================

export function createSumma<const TPlugins extends readonly SummaPlugin[] = SummaPlugin[]>(
	options: SummaOptions & { plugins?: [...TPlugins] },
): Summa<InferPluginTypes<TPlugins>> {
	let workerRunner: SummaWorkerRunner | null = null;

	const ctxPromise = (async () => {
		const ctx = await buildContext(options);
		await initializeSystemAccounts(ctx);
		for (const plugin of ctx.plugins) {
			if (plugin.init) await plugin.init(ctx);
		}
		return ctx;
	})();

	const getCtx = () => ctxPromise;

	return {
		accounts: {
			create: async (params) => {
				const ctx = await getCtx();
				return accounts.createAccount(ctx, params);
			},
			get: async (holderId) => {
				const ctx = await getCtx();
				return accounts.getAccountByHolder(ctx, holderId);
			},
			getById: async (accountId) => {
				const ctx = await getCtx();
				return accounts.getAccountById(ctx, accountId);
			},
			getBalance: async (holderId) => {
				const ctx = await getCtx();
				const acct = await accounts.getAccountByHolder(ctx, holderId);
				return accounts.getAccountBalance(ctx, acct);
			},
			freeze: async (params) => {
				const ctx = await getCtx();
				return accounts.freezeAccount(ctx, params);
			},
			unfreeze: async (params) => {
				const ctx = await getCtx();
				return accounts.unfreezeAccount(ctx, params);
			},
			close: async (params) => {
				const ctx = await getCtx();
				return accounts.closeAccount(ctx, params);
			},
			list: async (params) => {
				const ctx = await getCtx();
				return accounts.listAccounts(ctx, params);
			},
		},
		chartOfAccounts: {
			getByType: async (accountType) => {
				const ctx = await getCtx();
				return getAccountsByType(ctx, accountType);
			},
			getChildren: async (parentAccountId) => {
				const ctx = await getCtx();
				return getChildAccounts(ctx, parentAccountId);
			},
			getHierarchy: async (rootAccountId) => {
				const ctx = await getCtx();
				return getAccountHierarchy(ctx, rootAccountId);
			},
			validateEquation: async () => {
				const ctx = await getCtx();
				return validateAccountingEquation(ctx);
			},
		},
		transactions: {
			credit: async (params) => {
				const ctx = await getCtx();
				return transactions.creditAccount(ctx, params);
			},
			debit: async (params) => {
				const ctx = await getCtx();
				return transactions.debitAccount(ctx, params);
			},
			transfer: async (params) => {
				const ctx = await getCtx();
				return transactions.transfer(ctx, params);
			},
			multiTransfer: async (params) => {
				const ctx = await getCtx();
				return transactions.multiTransfer(ctx, params);
			},
			refund: async (params) => {
				const ctx = await getCtx();
				return transactions.refundTransaction(ctx, params);
			},
			correct: async (params) => {
				const ctx = await getCtx();
				return corrections.correctTransaction(ctx, params);
			},
			adjust: async (params) => {
				const ctx = await getCtx();
				return corrections.adjustmentEntry(ctx, params);
			},
			journal: async (params) => {
				const ctx = await getCtx();
				return journal.journalEntry(ctx, params);
			},
			get: async (id) => {
				const ctx = await getCtx();
				return transactions.getTransaction(ctx, id);
			},
			list: async (params) => {
				const ctx = await getCtx();
				return transactions.listAccountTransactions(ctx, params);
			},
		},
		holds: {
			create: async (params) => {
				const ctx = await getCtx();
				return holds.createHold(ctx, params);
			},
			createMultiDestination: async (params) => {
				const ctx = await getCtx();
				return holds.createMultiDestinationHold(ctx, params);
			},
			createMultiDest: async (params) => {
				const ctx = await getCtx();
				return holds.createMultiDestinationHold(ctx, params);
			},
			commit: async (params) => {
				const ctx = await getCtx();
				return holds.commitHold(ctx, params);
			},
			void: async (params) => {
				const ctx = await getCtx();
				return holds.voidHold(ctx, params);
			},
			expireAll: async () => {
				const ctx = await getCtx();
				return holds.expireHolds(ctx);
			},
			get: async (id) => {
				const ctx = await getCtx();
				return holds.getHold(ctx, id);
			},
			listActive: async (params) => {
				const ctx = await getCtx();
				return holds.listActiveHolds(ctx, params);
			},
			listAll: async (params) => {
				const ctx = await getCtx();
				return holds.listAllHolds(ctx, params);
			},
		},
		events: {
			getForAggregate: async (type, id) => {
				const ctx = await getCtx();
				return events.getEvents(ctx, type, id);
			},
			getByCorrelation: async (correlationId) => {
				const ctx = await getCtx();
				return events.getEventsByCorrelation(ctx, correlationId);
			},
			verifyChain: async (type, id) => {
				const ctx = await getCtx();
				return hashChain.verifyHashChain(ctx, type.toLowerCase(), id);
			},
			verifyExternalAnchor: async (blockSequence: number, externalBlockHash: string) => {
				const ctx = await getCtx();
				return hashChain.verifyExternalAnchor(ctx, blockSequence, externalBlockHash);
			},
			generateProof: async (eventId) => {
				const ctx = await getCtx();
				return hashChain.generateEventProof(ctx, eventId);
			},
			verifyProof: async (proof, blockId) => {
				const ctx = await getCtx();
				return hashChain.verifyEventProof(ctx, proof, blockId);
			},
		},
		limits: {
			set: async (params) => {
				const ctx = await getCtx();
				return limits.setLimit(ctx, params);
			},
			get: async (holderId) => {
				const ctx = await getCtx();
				return limits.getLimits(ctx, { holderId });
			},
			remove: async (params) => {
				const ctx = await getCtx();
				return limits.removeLimit(ctx, params);
			},
			getUsage: async (params) => {
				const ctx = await getCtx();
				return limits.getUsageSummary(ctx, params);
			},
		},
		workers: {
			start: async () => {
				const ctx = await getCtx();
				workerRunner = createWorkerRunner(ctx);
				workerRunner.start();
			},
			stop: async () => {
				if (workerRunner) {
					await workerRunner.stop();
					workerRunner = null;
				}
			},
		},
		$context: ctxPromise,
		$options: options,
		$Infer: {} as InferPluginTypes<TPlugins>,
	};
}
