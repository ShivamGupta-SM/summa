export const AGGREGATE_TYPES = {
	ACCOUNT: "account",
	TRANSACTION: "transaction",
	HOLD: "hold",
	SCHEDULED_TRANSACTION: "scheduled_transaction",
} as const;

export type AggregateType = (typeof AGGREGATE_TYPES)[keyof typeof AGGREGATE_TYPES];

export const ACCOUNT_EVENTS = {
	CREATED: "AccountCreated",
	FROZEN: "AccountFrozen",
	UNFROZEN: "AccountUnfrozen",
	CLOSED: "AccountClosed",
} as const;

export const TRANSACTION_EVENTS = {
	INITIATED: "TransactionInitiated",
	POSTED: "TransactionPosted",
	REVERSED: "TransactionReversed",
} as const;

export const HOLD_EVENTS = {
	CREATED: "HoldCreated",
	COMMITTED: "HoldCommitted",
	VOIDED: "HoldVoided",
	EXPIRED: "HoldExpired",
} as const;

export const SCHEDULED_EVENTS = {
	CREATED: "ScheduledTransactionCreated",
	CANCELLED: "ScheduledTransactionCancelled",
	PROCESSING: "ScheduledTransactionProcessing",
	COMPLETED: "ScheduledTransactionCompleted",
	RESCHEDULED: "ScheduledTransactionRescheduled",
	FAILED: "ScheduledTransactionFailed",
} as const;

export interface StoredEvent {
	id: string;
	sequenceNumber: number;
	aggregateType: string;
	aggregateId: string;
	aggregateVersion: number;
	eventType: string;
	eventData: Record<string, unknown>;
	correlationId: string;
	hash: string;
	prevHash: string | null;
	createdAt: Date;
}

export interface AppendEventParams {
	aggregateType: string;
	aggregateId: string;
	eventType: string;
	eventData: Record<string, unknown>;
	correlationId?: string;
}

export interface AccountCreatedData {
	holderId: string;
	holderType: string;
	currency: string;
	indicator?: string;
	allowOverdraft?: boolean;
}

export interface AccountFrozenData {
	reason: string;
	frozenBy: string;
}

export interface AccountUnfrozenData {
	unfrozenBy: string;
}

export interface AccountClosedData {
	closedBy: string;
	reason?: string;
	finalBalance: number;
	sweepTransactionId?: string;
}

export interface TransactionInitiatedData {
	reference: string;
	amount: number;
	currency: string;
	source: string;
	destination: string;
	description?: string;
}

export interface TransactionPostedData {
	postedAt: string;
	entries: Array<{
		accountId: string;
		entryType: "DEBIT" | "CREDIT";
		amount: number;
		balanceBefore: number;
		balanceAfter: number;
	}>;
}

export interface TransactionReversedData {
	reversalId: string;
	reason: string;
}

export interface HoldCreatedData {
	sourceAccountId: string;
	destinationAccountId?: string;
	amount: number;
	expiresAt: string;
	reference: string;
}

export interface HoldCommittedData {
	committedAmount: number;
	originalAmount: number;
}

export interface HoldVoidedData {
	reason: string;
}

export interface HoldExpiredData {
	expiredAt: string;
}
