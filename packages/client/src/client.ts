// =============================================================================
// SUMMA CLIENT — Type-safe HTTP client for the Summa ledger API
// =============================================================================

import type {
	Account,
	AccountBalance,
	AccountLimitInfo,
	AccountStatus,
	AccountType,
	Hold,
	HoldDestination,
	HolderType,
	JournalEntryLeg,
	LedgerTransaction,
	LimitType,
	StoredEvent,
	TransactionStatus,
	TransactionType,
} from "@summa-ledger/core";
import { createFetchClient } from "./fetch.js";
import type { SummaClientOptions } from "./types.js";

// =============================================================================
// CLIENT INTERFACE
// =============================================================================

export interface SummaClient {
	accounts: {
		create(params: {
			holderId: string;
			holderType: HolderType;
			currency?: string;
			allowOverdraft?: boolean;
			indicator?: string;
			metadata?: Record<string, unknown>;
		}): Promise<Account>;

		get(holderId: string): Promise<Account>;

		getBalance(holderId: string): Promise<AccountBalance>;

		freeze(params: { holderId: string; reason: string; frozenBy: string }): Promise<Account>;

		unfreeze(params: { holderId: string; unfrozenBy: string; reason?: string }): Promise<Account>;

		close(params: {
			holderId: string;
			closedBy: string;
			reason?: string;
			transferToHolderId?: string;
		}): Promise<Account>;

		list(params?: {
			page?: number;
			perPage?: number;
			status?: AccountStatus;
			holderType?: HolderType;
			search?: string;
		}): Promise<{ accounts: Account[]; hasMore: boolean; total: number }>;
	};

	chartOfAccounts: {
		getByType(accountType: AccountType): Promise<Account[]>;
		getChildren(parentAccountId: string): Promise<Account[]>;
		getHierarchy(rootAccountId?: string): Promise<unknown[]>;
		validateEquation(): Promise<{
			balanced: boolean;
			assets: number;
			liabilities: number;
			equity: number;
			difference: number;
		}>;
	};

	transactions: {
		credit(params: {
			holderId: string;
			amount: number;
			reference: string;
			description?: string;
			category?: string;
			metadata?: Record<string, unknown>;
			sourceSystemAccount?: string;
			idempotencyKey?: string;
		}): Promise<LedgerTransaction>;

		debit(params: {
			holderId: string;
			amount: number;
			reference: string;
			description?: string;
			category?: string;
			metadata?: Record<string, unknown>;
			destinationSystemAccount?: string;
			allowOverdraft?: boolean;
			idempotencyKey?: string;
		}): Promise<LedgerTransaction>;

		transfer(params: {
			sourceHolderId: string;
			destinationHolderId: string;
			amount: number;
			reference: string;
			description?: string;
			category?: string;
			metadata?: Record<string, unknown>;
			exchangeRate?: number;
			idempotencyKey?: string;
		}): Promise<LedgerTransaction>;

		multiTransfer(params: {
			sourceHolderId: string;
			amount: number;
			destinations: HoldDestination[];
			reference: string;
			description?: string;
			category?: string;
			metadata?: Record<string, unknown>;
			idempotencyKey?: string;
		}): Promise<LedgerTransaction>;

		refund(params: {
			transactionId: string;
			reason: string;
			amount?: number;
			idempotencyKey?: string;
		}): Promise<LedgerTransaction>;

		correct(params: {
			transactionId: string;
			correctionEntries: JournalEntryLeg[];
			reason: string;
			reference?: string;
			idempotencyKey?: string;
		}): Promise<{ reversal: LedgerTransaction; correction: LedgerTransaction }>;

		adjust(params: {
			entries: JournalEntryLeg[];
			reference: string;
			adjustmentType: "accrual" | "depreciation" | "correction" | "reclassification";
			description?: string;
			metadata?: Record<string, unknown>;
			idempotencyKey?: string;
		}): Promise<LedgerTransaction>;

		journal(params: {
			entries: JournalEntryLeg[];
			reference: string;
			description?: string;
			metadata?: Record<string, unknown>;
			idempotencyKey?: string;
		}): Promise<LedgerTransaction>;

		get(id: string): Promise<LedgerTransaction>;

		list(params: {
			holderId: string;
			page?: number;
			perPage?: number;
			status?: TransactionStatus;
			category?: string;
			type?: TransactionType;
			dateFrom?: string;
			dateTo?: string;
			amountMin?: number;
			amountMax?: number;
		}): Promise<{
			transactions: LedgerTransaction[];
			hasMore: boolean;
			total?: number;
		}>;
	};

	holds: {
		create(params: {
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
		}): Promise<Hold>;

		commit(params: { holdId: string; amount?: number }): Promise<{
			holdId: string;
			committedAmount: number;
			originalAmount: number;
		}>;

		void(params: { holdId: string; reason?: string }): Promise<{
			holdId: string;
			amount: number;
		}>;

		get(id: string): Promise<Hold>;

		listActive(params: {
			holderId: string;
			page?: number;
			perPage?: number;
			category?: string;
		}): Promise<{ holds: Hold[]; hasMore: boolean; total?: number }>;

		createMultiDestination(params: {
			holderId: string;
			amount: number;
			reference: string;
			destinations: HoldDestination[];
			description?: string;
			category?: string;
			expiresInMinutes?: number;
			metadata?: Record<string, unknown>;
			idempotencyKey?: string;
		}): Promise<Hold>;

		listAll(params: {
			holderId: string;
			page?: number;
			perPage?: number;
			category?: string;
			status?: "inflight" | "posted" | "voided" | "expired";
		}): Promise<{ holds: Hold[]; hasMore: boolean; total?: number }>;
	};

	events: {
		getForAggregate(type: string, id: string): Promise<StoredEvent[]>;
		getByCorrelation(correlationId: string): Promise<StoredEvent[]>;
		verifyChain(
			type: string,
			id: string,
		): Promise<{ valid: boolean; brokenAtVersion?: number; eventCount: number }>;
	};

	limits: {
		set(params: {
			holderId: string;
			limitType: LimitType;
			maxAmount: number;
			category?: string;
			enabled?: boolean;
		}): Promise<AccountLimitInfo>;

		get(holderId: string): Promise<AccountLimitInfo[]>;

		remove(params: { holderId: string; limitType: LimitType; category?: string }): Promise<void>;

		getUsage(params: {
			holderId: string;
			txnType?: "credit" | "debit" | "hold";
			category?: string;
		}): Promise<{ daily: number; monthly: number }>;
	};
}

// =============================================================================
// FACTORY
// =============================================================================

function e(value: string): string {
	return encodeURIComponent(value);
}

function toQuery(obj: Record<string, unknown>): Record<string, string | undefined> {
	const query: Record<string, string | undefined> = {};
	for (const [key, val] of Object.entries(obj)) {
		if (val !== undefined) query[key] = String(val);
	}
	return query;
}

export function createSummaClient(options: SummaClientOptions): SummaClient {
	const http = createFetchClient(options);

	return {
		accounts: {
			create: (params) => http.post("/accounts", params),
			get: (holderId) => http.get(`/accounts/${e(holderId)}`),
			getBalance: (holderId) => http.get(`/accounts/${e(holderId)}/balance`),
			freeze: ({ holderId, ...body }) => http.post(`/accounts/${e(holderId)}/freeze`, body),
			unfreeze: ({ holderId, ...body }) => http.post(`/accounts/${e(holderId)}/unfreeze`, body),
			close: ({ holderId, ...body }) => http.post(`/accounts/${e(holderId)}/close`, body),
			list: (params) => http.get("/accounts", toQuery(params ?? {})),
		},

		chartOfAccounts: {
			getByType: (accountType) => http.get("/chart-of-accounts/by-type", { accountType }),
			getChildren: (parentAccountId) =>
				http.get(`/chart-of-accounts/${e(parentAccountId)}/children`),
			getHierarchy: (rootAccountId) =>
				http.get("/chart-of-accounts/hierarchy", rootAccountId ? { rootAccountId } : {}),
			validateEquation: () => http.get("/chart-of-accounts/validate"),
		},

		transactions: {
			credit: (params) => http.post("/transactions/credit", params),
			debit: (params) => http.post("/transactions/debit", params),
			transfer: (params) => http.post("/transactions/transfer", params),
			multiTransfer: (params) => http.post("/transactions/multi-transfer", params),
			refund: (params) => http.post("/transactions/refund", params),
			correct: (params) => http.post("/transactions/correct", params),
			adjust: (params) => http.post("/transactions/adjust", params),
			journal: (params) => http.post("/transactions/journal", params),
			get: (id) => http.get(`/transactions/${e(id)}`),
			list: ({ holderId, ...rest }) => http.get("/transactions", toQuery({ holderId, ...rest })),
		},

		holds: {
			create: (params) => http.post("/holds", params),
			createMultiDestination: (params) => http.post("/holds/multi-destination", params),
			commit: ({ holdId, ...body }) => http.post(`/holds/${e(holdId)}/commit`, body),
			void: ({ holdId, ...body }) => http.post(`/holds/${e(holdId)}/void`, body),
			get: (id) => http.get(`/holds/${e(id)}`),
			listActive: ({ holderId, ...rest }) =>
				http.get("/holds/active", toQuery({ holderId, ...rest })),
			listAll: ({ holderId, ...rest }) => http.get("/holds", toQuery({ holderId, ...rest })),
		},

		events: {
			getForAggregate: (type, id) => http.get(`/events/${e(type)}/${e(id)}`),
			getByCorrelation: (correlationId) => http.get(`/events/correlation/${e(correlationId)}`),
			verifyChain: (type, id) =>
				http.post("/events/verify", { aggregateType: type, aggregateId: id }),
		},

		limits: {
			set: (params) => http.post("/limits", params),
			get: (holderId) => http.get(`/limits/${e(holderId)}`),
			remove: ({ holderId, ...body }) => http.del(`/limits/${e(holderId)}`, body),
			getUsage: ({ holderId, ...rest }) => http.get(`/limits/${e(holderId)}/usage`, toQuery(rest)),
		},
	};
}
