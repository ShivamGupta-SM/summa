import { describe, expect, it } from "vitest";
import { SummaError } from "../error/index.js";

describe("SummaError", () => {
	describe("constructor", () => {
		it("creates an error with the given code and message", () => {
			const error = new SummaError("NOT_FOUND", "Account not found");
			expect(error.code).toBe("NOT_FOUND");
			expect(error.message).toBe("Account not found");
		});

		it("is an instance of Error", () => {
			const error = new SummaError("INTERNAL", "Something went wrong");
			expect(error).toBeInstanceOf(Error);
		});

		it("is an instance of SummaError", () => {
			const error = new SummaError("INTERNAL", "Something went wrong");
			expect(error).toBeInstanceOf(SummaError);
		});

		it("has the name 'SummaError'", () => {
			const error = new SummaError("CONFLICT", "Conflict occurred");
			expect(error.name).toBe("SummaError");
		});

		it("has a stack trace", () => {
			const error = new SummaError("INTERNAL", "test");
			expect(error.stack).toBeDefined();
			expect(typeof error.stack).toBe("string");
		});
	});

	describe("static factory: notFound", () => {
		it("creates an error with code NOT_FOUND", () => {
			const error = SummaError.notFound("Account not found");
			expect(error.code).toBe("NOT_FOUND");
			expect(error.message).toBe("Account not found");
		});

		it("uses default message when none provided", () => {
			const error = SummaError.notFound();
			expect(error.code).toBe("NOT_FOUND");
			expect(error.message).toBe("Resource not found");
		});
	});

	describe("static factory: invalidArgument", () => {
		it("creates an error with code INVALID_ARGUMENT", () => {
			const error = SummaError.invalidArgument("Amount must be positive");
			expect(error.code).toBe("INVALID_ARGUMENT");
			expect(error.message).toBe("Amount must be positive");
		});

		it("uses default message when none provided", () => {
			const error = SummaError.invalidArgument();
			expect(error.code).toBe("INVALID_ARGUMENT");
			expect(error.message).toBe("Invalid argument");
		});
	});

	describe("static factory: conflict", () => {
		it("creates an error with code CONFLICT", () => {
			const error = SummaError.conflict("Transaction already processed");
			expect(error.code).toBe("CONFLICT");
			expect(error.message).toBe("Transaction already processed");
		});

		it("uses default message when none provided", () => {
			const error = SummaError.conflict();
			expect(error.code).toBe("CONFLICT");
			expect(error.message).toBe("Conflict");
		});
	});

	describe("static factory: internal", () => {
		it("creates an error with code INTERNAL", () => {
			const error = SummaError.internal("Database connection failed");
			expect(error.code).toBe("INTERNAL");
			expect(error.message).toBe("Database connection failed");
		});

		it("uses default message when none provided", () => {
			const error = SummaError.internal();
			expect(error.code).toBe("INTERNAL");
			expect(error.message).toBe("Internal error");
		});
	});

	describe("static factory: insufficientBalance", () => {
		it("creates an error with code INSUFFICIENT_BALANCE", () => {
			const error = SummaError.insufficientBalance("Not enough funds");
			expect(error.code).toBe("INSUFFICIENT_BALANCE");
			expect(error.message).toBe("Not enough funds");
		});

		it("uses default message when none provided", () => {
			const error = SummaError.insufficientBalance();
			expect(error.code).toBe("INSUFFICIENT_BALANCE");
			expect(error.message).toBe("Insufficient balance");
		});
	});

	describe("static factory: accountFrozen", () => {
		it("creates an error with code ACCOUNT_FROZEN", () => {
			const error = SummaError.accountFrozen("Account suspended by admin");
			expect(error.code).toBe("ACCOUNT_FROZEN");
			expect(error.message).toBe("Account suspended by admin");
		});

		it("uses default message when none provided", () => {
			const error = SummaError.accountFrozen();
			expect(error.code).toBe("ACCOUNT_FROZEN");
			expect(error.message).toBe("Account is frozen");
		});
	});

	describe("static factory: accountClosed", () => {
		it("creates an error with code ACCOUNT_CLOSED", () => {
			const error = SummaError.accountClosed("Account was terminated");
			expect(error.code).toBe("ACCOUNT_CLOSED");
			expect(error.message).toBe("Account was terminated");
		});

		it("uses default message when none provided", () => {
			const error = SummaError.accountClosed();
			expect(error.code).toBe("ACCOUNT_CLOSED");
			expect(error.message).toBe("Account is closed");
		});
	});

	describe("static factory: limitExceeded", () => {
		it("creates an error with code LIMIT_EXCEEDED", () => {
			const error = SummaError.limitExceeded("Daily limit reached");
			expect(error.code).toBe("LIMIT_EXCEEDED");
			expect(error.message).toBe("Daily limit reached");
		});

		it("uses default message when none provided", () => {
			const error = SummaError.limitExceeded();
			expect(error.code).toBe("LIMIT_EXCEEDED");
			expect(error.message).toBe("Transaction limit exceeded");
		});
	});

	describe("static factory: duplicate", () => {
		it("creates an error with code DUPLICATE", () => {
			const error = SummaError.duplicate("Idempotency key already used");
			expect(error.code).toBe("DUPLICATE");
			expect(error.message).toBe("Idempotency key already used");
		});

		it("uses default message when none provided", () => {
			const error = SummaError.duplicate();
			expect(error.code).toBe("DUPLICATE");
			expect(error.message).toBe("Duplicate resource");
		});
	});

	describe("error behavior", () => {
		it("can be thrown and caught", () => {
			expect(() => {
				throw SummaError.notFound("Not found");
			}).toThrow(SummaError);
		});

		it("can be caught by Error type", () => {
			expect(() => {
				throw SummaError.internal("fail");
			}).toThrow(Error);
		});

		it("message is accessible in catch block", () => {
			try {
				throw SummaError.insufficientBalance("Funds too low");
			} catch (e) {
				expect(e).toBeInstanceOf(SummaError);
				if (e instanceof SummaError) {
					expect(e.message).toBe("Funds too low");
					expect(e.code).toBe("INSUFFICIENT_BALANCE");
				}
			}
		});
	});
});
