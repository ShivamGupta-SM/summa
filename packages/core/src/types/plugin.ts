import type { RawErrorCode } from "../error/codes.js";
import type { SummaContext } from "./context.js";

// =============================================================================
// PLUGIN REGISTRY (Module Augmentation)
// =============================================================================

/**
 * Plugin registry for TypeScript module augmentation.
 * Plugins declare themselves here for type-safe `hasPlugin()` and context inference.
 *
 * @example
 * ```ts
 * declare module "@summa/core" {
 *   interface SummaPluginRegistry {
 *     "velocity-limits": {
 *       context: { limits: LimitManager };
 *     }
 *   }
 * }
 * ```
 */
// biome-ignore lint/suspicious/noEmptyInterface: used for declaration merging
export interface SummaPluginRegistry {}

export type SummaPluginId = keyof SummaPluginRegistry;

// =============================================================================
// OPERATION TYPES (for matcher-based hooks)
// =============================================================================

export type SummaOperation =
	| { type: "account.create"; params: Record<string, unknown> }
	| { type: "account.freeze"; params: Record<string, unknown> }
	| { type: "account.unfreeze"; params: Record<string, unknown> }
	| { type: "account.close"; params: Record<string, unknown> }
	| { type: "transaction.credit"; params: Record<string, unknown> }
	| { type: "transaction.debit"; params: Record<string, unknown> }
	| { type: "transaction.transfer"; params: Record<string, unknown> }
	| { type: "transaction.refund"; params: Record<string, unknown> }
	| { type: "transaction.correct"; params: Record<string, unknown> }
	| { type: "transaction.adjust"; params: Record<string, unknown> }
	| { type: "transaction.journal"; params: Record<string, unknown> }
	| { type: "hold.create"; params: Record<string, unknown> }
	| { type: "hold.commit"; params: Record<string, unknown> }
	| { type: "hold.void"; params: { holdId: string } };

export interface SummaHookContext {
	operation: SummaOperation;
	context: SummaContext;
	requestContext?: import("./context.js").RequestContext;
}

// =============================================================================
// TABLE DEFINITION (for plugin schema contributions)
// =============================================================================

export interface ColumnDefinition {
	type:
		| "text"
		| "integer"
		| "bigint"
		| "boolean"
		| "timestamp"
		| "jsonb"
		| "uuid"
		| "serial"
		| "tsvector";
	primaryKey?: boolean;
	notNull?: boolean;
	default?: string;
	references?: { table: string; column: string };
}

export interface TableDefinition {
	/** When true, this definition extends an existing table rather than creating a new one. */
	extend?: boolean;
	columns: Record<string, ColumnDefinition>;
	indexes?: Array<{
		name: string;
		columns: string[];
		unique?: boolean;
		/** Index method: btree (default) or gin (for tsvector/jsonb columns). */
		using?: "btree" | "gin";
	}>;
}

// =============================================================================
// PLUGIN ENDPOINT (for plugin-contributed HTTP routes)
// =============================================================================

export interface PluginEndpoint {
	method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
	path: string;
	handler: (req: PluginApiRequest, ctx: SummaContext) => Promise<PluginApiResponse>;
}

export interface PluginApiRequest {
	method: string;
	path: string;
	body: unknown;
	query: Record<string, string | undefined>;
	params: Record<string, string>;
	headers?: Record<string, string>;
}

export interface PluginApiResponse {
	status: number;
	body: unknown;
	headers?: Record<string, string>;
}

// =============================================================================
// PLUGIN INTERFACE
// =============================================================================

export interface SummaPlugin {
	id: string;

	/** Plugin IDs that must be registered before this plugin. Used for load ordering and validation. */
	dependencies?: string[];

	/** Called during createSumma() initialization */
	init?: (ctx: SummaContext) => Promise<void> | void;

	/** Lifecycle hooks (existing — used by all current plugins) */
	hooks?: {
		beforeTransaction?: (params: TransactionHookParams) => Promise<void>;
		afterTransaction?: (params: TransactionHookParams) => Promise<void>;
		beforeAccountCreate?: (params: AccountHookParams) => Promise<void>;
		afterAccountCreate?: (params: AccountHookParams) => Promise<void>;
		beforeHoldCreate?: (params: HoldHookParams) => Promise<void>;
		afterHoldCommit?: (params: HoldCommitHookParams) => Promise<void>;
	};

	/** Generic matcher-based hooks (future-proof extension of hooks) */
	operationHooks?: {
		before?: Array<{
			matcher: (op: SummaOperation) => boolean;
			handler: (params: SummaHookContext) => Promise<undefined | { cancel: true; reason: string }>;
		}>;
		after?: Array<{
			matcher: (op: SummaOperation) => boolean;
			handler: (params: SummaHookContext) => Promise<void>;
		}>;
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

	/** HTTP endpoint contributions (routes served by the API handler) */
	endpoints?: PluginEndpoint[];

	/** Schema extension — tables added or extended by this plugin */
	schema?: Record<string, TableDefinition>;

	/** Typed error codes contributed by this plugin */
	$ERROR_CODES?: Record<string, RawErrorCode>;

	/** Type inference hints (for TypeScript DX — runtime value is unused) */
	$Infer?: Record<string, unknown>;

	/** Rate limiting rules for specific operations */
	rateLimit?: Array<{
		operation: string | ((op: string) => boolean);
		/** Window size in seconds */
		window: number;
		/** Max operations in window */
		max: number;
	}>;

	/** HTTP-level request interceptor. Return a PluginApiResponse to short-circuit. */
	onRequest?: (
		req: PluginApiRequest,
	) => PluginApiRequest | PluginApiResponse | Promise<PluginApiRequest | PluginApiResponse>;

	/** HTTP-level response interceptor. Runs in reverse plugin order (middleware stack unwinding). */
	onResponse?: (
		req: PluginApiRequest,
		res: PluginApiResponse,
	) => PluginApiResponse | Promise<PluginApiResponse>;
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
	type: "credit" | "debit" | "transfer" | "correction" | "adjustment" | "journal";
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

// =============================================================================
// $INFER — Extract plugin type hints
// =============================================================================

/**
 * Merge $Infer from an array of plugins into a single intersection type.
 *
 * @example
 * ```ts
 * type Types = InferPluginTypes<[typeof auditLogPlugin, typeof outboxPlugin]>;
 * // { AuditLogEntry: ...; OutboxStats: ... }
 * ```
 */
export type InferPluginTypes<TPlugins extends readonly SummaPlugin[]> = TPlugins extends readonly [
	infer First extends SummaPlugin,
	...infer Rest extends SummaPlugin[],
]
	? (First["$Infer"] extends Record<string, unknown> ? First["$Infer"] : Record<string, never>) &
			InferPluginTypes<Rest>
	: Record<string, never>;
