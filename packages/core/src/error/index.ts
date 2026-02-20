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
	code: SummaErrorCode;

	constructor(code: SummaErrorCode, message: string) {
		super(message);
		this.code = code;
		this.name = "SummaError";
	}

	static insufficientBalance(message = "Insufficient balance") {
		return new SummaError("INSUFFICIENT_BALANCE", message);
	}

	static accountFrozen(message = "Account is frozen") {
		return new SummaError("ACCOUNT_FROZEN", message);
	}

	static accountClosed(message = "Account is closed") {
		return new SummaError("ACCOUNT_CLOSED", message);
	}

	static limitExceeded(message = "Transaction limit exceeded") {
		return new SummaError("LIMIT_EXCEEDED", message);
	}

	static notFound(message = "Resource not found") {
		return new SummaError("NOT_FOUND", message);
	}

	static invalidArgument(message = "Invalid argument") {
		return new SummaError("INVALID_ARGUMENT", message);
	}

	static duplicate(message = "Duplicate resource") {
		return new SummaError("DUPLICATE", message);
	}

	static conflict(message = "Conflict") {
		return new SummaError("CONFLICT", message);
	}

	static internal(message = "Internal error") {
		return new SummaError("INTERNAL", message);
	}
}
