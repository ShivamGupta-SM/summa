import type { SummaContext } from "./context.js";

// =============================================================================
// PLUGIN INTERFACE
// =============================================================================

export interface SummaPlugin {
	id: string;

	/** Called during createSumma() initialization */
	init?: (ctx: SummaContext) => Promise<void> | void;

	/** Lifecycle hooks */
	hooks?: {
		beforeTransaction?: (params: TransactionHookParams) => Promise<void>;
		afterTransaction?: (params: TransactionHookParams) => Promise<void>;
		beforeAccountCreate?: (params: AccountHookParams) => Promise<void>;
		afterAccountCreate?: (params: AccountHookParams) => Promise<void>;
		beforeHoldCreate?: (params: HoldHookParams) => Promise<void>;
		afterHoldCommit?: (params: HoldCommitHookParams) => Promise<void>;
	};

	/** Background workers that process data on intervals */
	workers?: SummaWorkerDefinition[];

	/** Scheduled tasks (user provides their own cron runner) */
	scheduledTasks?: Array<{
		id: string;
		description: string;
		handler: (ctx: SummaContext) => Promise<void>;
		suggestedInterval: string;
	}>;
}

// =============================================================================
// WORKER DEFINITION
// =============================================================================

export interface SummaWorkerDefinition {
	/** Unique worker ID (e.g., "outbox-processor") */
	id: string;

	/** Human-readable description */
	description?: string;

	/** Worker handler function */
	handler: (ctx: SummaContext) => Promise<void>;

	/** Suggested polling interval (e.g., "5s", "1m", "1h", "1d") */
	interval: string;

	/** Whether this worker requires a distributed lease (prevents duplicate runs) */
	leaseRequired?: boolean;
}

// =============================================================================
// HOOK PARAMS
// =============================================================================

export interface TransactionHookParams {
	type: "credit" | "debit" | "transfer";
	amount: number;
	reference: string;
	holderId?: string;
	sourceHolderId?: string;
	destinationHolderId?: string;
	category?: string;
	ctx: SummaContext;
}

export interface AccountHookParams {
	holderId: string;
	holderType: string;
	accountId?: string;
	ctx: SummaContext;
}

export interface HoldHookParams {
	holderId: string;
	amount: number;
	reference: string;
	ctx: SummaContext;
}

export interface HoldCommitHookParams {
	holdId: string;
	committedAmount: number;
	originalAmount: number;
	ctx: SummaContext;
}
