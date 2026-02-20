export type SummaErrorCode =
	| "INSUFFICIENT_BALANCE"
	| "ACCOUNT_FROZEN"
	| "ACCOUNT_CLOSED"
	| "LIMIT_EXCEEDED"
	| "NOT_FOUND"
	| "INVALID_ARGUMENT"
	| "DUPLICATE"
	| "CONFLICT"
	| "INTERNAL";

export class SummaError extends Error {
	readonly code: SummaErrorCode;

	constructor(code: SummaErrorCode, message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.code = code;
		this.name = "SummaError";
	}

	static insufficientBalance(message = "Insufficient balance", cause?: unknown) {
		return new SummaError("INSUFFICIENT_BALANCE", message, { cause });
	}

	static accountFrozen(message = "Account is frozen", cause?: unknown) {
		return new SummaError("ACCOUNT_FROZEN", message, { cause });
	}

	static accountClosed(message = "Account is closed", cause?: unknown) {
		return new SummaError("ACCOUNT_CLOSED", message, { cause });
	}

	static limitExceeded(message = "Transaction limit exceeded", cause?: unknown) {
		return new SummaError("LIMIT_EXCEEDED", message, { cause });
	}

	static notFound(message = "Resource not found", cause?: unknown) {
		return new SummaError("NOT_FOUND", message, { cause });
	}

	static invalidArgument(message = "Invalid argument", cause?: unknown) {
		return new SummaError("INVALID_ARGUMENT", message, { cause });
	}

	static duplicate(message = "Duplicate resource", cause?: unknown) {
		return new SummaError("DUPLICATE", message, { cause });
	}

	static conflict(message = "Conflict", cause?: unknown) {
		return new SummaError("CONFLICT", message, { cause });
	}

	static internal(message = "Internal error", cause?: unknown) {
		return new SummaError("INTERNAL", message, { cause });
	}
}
