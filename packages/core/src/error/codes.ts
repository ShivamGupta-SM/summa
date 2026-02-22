// =============================================================================
// TYPED ERROR CODES
// =============================================================================
// Provides a typed error code registry with HTTP status codes and default messages.
// Plugins can extend this by declaring their own error codes via `$ERROR_CODES`.

export type RawErrorCode = {
	message: string;
	status: number;
	/**
	 * Whether this error is transient (retrying may succeed).
	 *
	 * Inspired by TigerBeetle's `CreateTransferResult.transient()` which classifies
	 * each error code as either transient (balance changes, account not yet created)
	 * or deterministic (validation failures, flag conflicts).
	 *
	 * - `true`: Condition may change — client should retry with a NEW idempotency key.
	 * - `false` (default): Condition is permanent — retrying will always fail.
	 */
	transient?: boolean;
};

export const BASE_ERROR_CODES = {
	// Transient errors — condition may change, client should retry with a NEW idempotency key.
	// Inspired by TigerBeetle's transient error classification.
	INSUFFICIENT_BALANCE: { message: "Insufficient balance", status: 400, transient: true },
	ACCOUNT_FROZEN: { message: "Account is frozen", status: 403, transient: true },
	LIMIT_EXCEEDED: { message: "Transaction limit exceeded", status: 429, transient: true },
	NOT_FOUND: { message: "Resource not found", status: 404, transient: true },
	HOLD_EXPIRED: { message: "Hold has expired", status: 410, transient: true },
	RATE_LIMITED: { message: "Rate limit exceeded", status: 429, transient: true },

	// Deterministic errors — condition is permanent, retrying will always fail.
	ACCOUNT_CLOSED: { message: "Account is closed", status: 403, transient: false },
	INVALID_ARGUMENT: { message: "Invalid argument", status: 400, transient: false },
	DUPLICATE: { message: "Duplicate operation", status: 409, transient: false },
	CONFLICT: { message: "Resource conflict", status: 409, transient: false },
	INTERNAL: { message: "Internal error", status: 500, transient: false },
	CHAIN_INTEGRITY_VIOLATION: {
		message: "Hash chain integrity violated",
		status: 500,
		transient: false,
	},
} as const satisfies Record<string, RawErrorCode>;

export type BaseErrorCode = keyof typeof BASE_ERROR_CODES;

// =============================================================================
// PLUGIN ERROR CODE UTILITIES
// =============================================================================

/**
 * Create typed error codes for a plugin. Returns a frozen object.
 *
 * @example
 * ```ts
 * export const ADMIN_ERROR_CODES = createErrorCodes({
 *   ADMIN_UNAUTHORIZED: { message: "Admin access required", status: 403 },
 * });
 * ```
 */
export function createErrorCodes<T extends Record<string, RawErrorCode>>(codes: T): Readonly<T> {
	return Object.freeze(codes);
}

/**
 * Merge error codes from a plugin tuple with the base error codes.
 *
 * @example
 * ```ts
 * type AllCodes = MergeErrorCodes<[typeof adminPlugin, typeof auditPlugin]>;
 * // BaseErrorCode | "ADMIN_UNAUTHORIZED" | "AUDIT_TAMPERED"
 * ```
 */
export type MergeErrorCodes<
	TPlugins extends readonly { $ERROR_CODES?: Record<string, RawErrorCode> }[],
> = BaseErrorCode | ExtractPluginErrorCodes<TPlugins>;

type ExtractPluginErrorCodes<
	TPlugins extends readonly { $ERROR_CODES?: Record<string, RawErrorCode> }[],
> = TPlugins extends readonly [
	infer First,
	...infer Rest extends { $ERROR_CODES?: Record<string, RawErrorCode> }[],
]
	?
			| (First extends { $ERROR_CODES: infer Codes extends Record<string, RawErrorCode> }
					? keyof Codes
					: never)
			| ExtractPluginErrorCodes<Rest>
	: never;
