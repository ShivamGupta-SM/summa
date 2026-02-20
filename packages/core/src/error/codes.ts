// =============================================================================
// TYPED ERROR CODES
// =============================================================================
// Provides a typed error code registry with HTTP status codes and default messages.
// Plugins can extend this by declaring their own error codes via `$ERROR_CODES`.

export type RawErrorCode = {
	message: string;
	status: number;
};

export const BASE_ERROR_CODES = {
	INSUFFICIENT_BALANCE: { message: "Insufficient balance", status: 400 },
	ACCOUNT_FROZEN: { message: "Account is frozen", status: 403 },
	ACCOUNT_CLOSED: { message: "Account is closed", status: 403 },
	LIMIT_EXCEEDED: { message: "Transaction limit exceeded", status: 429 },
	NOT_FOUND: { message: "Resource not found", status: 404 },
	INVALID_ARGUMENT: { message: "Invalid argument", status: 400 },
	DUPLICATE: { message: "Duplicate operation", status: 409 },
	CONFLICT: { message: "Resource conflict", status: 409 },
	INTERNAL: { message: "Internal error", status: 500 },
	HOLD_EXPIRED: { message: "Hold has expired", status: 410 },
	CHAIN_INTEGRITY_VIOLATION: { message: "Hash chain integrity violated", status: 500 },
	RATE_LIMITED: { message: "Rate limit exceeded", status: 429 },
} as const satisfies Record<string, RawErrorCode>;

export type BaseErrorCode = keyof typeof BASE_ERROR_CODES;
