import { BASE_ERROR_CODES, type BaseErrorCode } from "./codes.js";

export {
	BASE_ERROR_CODES,
	type BaseErrorCode,
	createErrorCodes,
	type MergeErrorCodes,
	type RawErrorCode,
} from "./codes.js";

export type SummaErrorCode = BaseErrorCode;

export class SummaError extends Error {
	readonly code: string;
	readonly status: number;
	readonly details?: Record<string, unknown>;
	/**
	 * Whether this error is transient — the condition may change and retrying
	 * (with a new idempotency key) may succeed.
	 *
	 * Inspired by TigerBeetle's `CreateTransferResult.transient()`.
	 *
	 * - `true`: Balance may increase, account may unfreeze, rate limit may reset.
	 * - `false`: Validation error, closed account, duplicate — will always fail.
	 *
	 * Clients can use this to decide whether to retry automatically.
	 */
	readonly transient: boolean;

	/** Base URL for error documentation. Override via SummaError.docsBaseUrl. */
	static docsBaseUrl = "https://summa.dev/docs/error-codes";

	constructor(
		code: string,
		message: string,
		options?: {
			cause?: unknown;
			status?: number;
			transient?: boolean;
			details?: Record<string, unknown>;
		},
	) {
		super(message, { cause: options?.cause });
		this.code = code;
		this.status = options?.status ?? 500;
		this.transient = options?.transient ?? false;
		this.details = options?.details;
		this.name = "SummaError";
	}

	/** Documentation URL for this error code. */
	get docsUrl(): string {
		return `${SummaError.docsBaseUrl}#${this.code.toLowerCase().replace(/_/g, "-")}`;
	}

	/**
	 * Create a SummaError from a typed error code.
	 * Uses the default message and status from BASE_ERROR_CODES.
	 */
	static fromCode<C extends SummaErrorCode>(
		code: C,
		options?: { message?: string; cause?: unknown; details?: Record<string, unknown> },
	): SummaError {
		const raw = BASE_ERROR_CODES[code] ?? { message: "Unknown error", status: 500 };
		return new SummaError(code, options?.message ?? raw.message, {
			cause: options?.cause,
			status: raw.status,
			transient: raw.transient,
			details: options?.details,
		});
	}

	// --- Transient errors (retrying with new idempotency key may succeed) ---

	static insufficientBalance(message = "Insufficient balance", cause?: unknown) {
		return new SummaError("INSUFFICIENT_BALANCE", message, { cause, status: 400, transient: true });
	}

	static accountFrozen(message = "Account is frozen", cause?: unknown) {
		return new SummaError("ACCOUNT_FROZEN", message, { cause, status: 403, transient: true });
	}

	static limitExceeded(message = "Transaction limit exceeded", cause?: unknown) {
		return new SummaError("LIMIT_EXCEEDED", message, { cause, status: 429, transient: true });
	}

	static notFound(message = "Resource not found", cause?: unknown) {
		return new SummaError("NOT_FOUND", message, { cause, status: 404, transient: true });
	}

	static holdExpired(message = "Hold has expired", cause?: unknown) {
		return new SummaError("HOLD_EXPIRED", message, { cause, status: 410, transient: true });
	}

	static rateLimited(message = "Rate limit exceeded", cause?: unknown) {
		return new SummaError("RATE_LIMITED", message, { cause, status: 429, transient: true });
	}

	static optimisticLockConflict(
		message = "Optimistic lock conflict: version already exists",
		cause?: unknown,
	) {
		return new SummaError("OPTIMISTIC_LOCK_CONFLICT", message, {
			cause,
			status: 409,
			transient: true,
		});
	}

	// --- Deterministic errors (retrying will always fail) ---

	static accountClosed(message = "Account is closed", cause?: unknown) {
		return new SummaError("ACCOUNT_CLOSED", message, { cause, status: 403, transient: false });
	}

	static invalidArgument(message = "Invalid argument", cause?: unknown) {
		return new SummaError("INVALID_ARGUMENT", message, { cause, status: 400, transient: false });
	}

	static duplicate(message = "Duplicate resource", cause?: unknown) {
		return new SummaError("DUPLICATE", message, { cause, status: 409, transient: false });
	}

	static conflict(message = "Conflict", cause?: unknown) {
		return new SummaError("CONFLICT", message, { cause, status: 409, transient: false });
	}

	static internal(message = "Internal error", cause?: unknown) {
		return new SummaError("INTERNAL", message, { cause, status: 500, transient: false });
	}

	static chainIntegrityViolation(message = "Hash chain integrity violated", cause?: unknown) {
		return new SummaError("CHAIN_INTEGRITY_VIOLATION", message, {
			cause,
			status: 500,
			transient: false,
		});
	}
}
