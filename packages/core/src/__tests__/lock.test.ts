import { describe, expect, it } from "vitest";
import { hashLockKey } from "../utils/lock.js";

describe("hashLockKey", () => {
	it("returns a number", () => {
		const result = hashLockKey("account:user-123");
		expect(typeof result).toBe("number");
	});

	it("returns a 32-bit integer (within int32 range)", () => {
		const result = hashLockKey("some-key");
		expect(Number.isInteger(result)).toBe(true);
		// 32-bit signed integer range: -2^31 to 2^31-1
		expect(result).toBeGreaterThanOrEqual(-2147483648);
		expect(result).toBeLessThanOrEqual(2147483647);
	});

	it("is deterministic (same input produces same output)", () => {
		const hash1 = hashLockKey("account:user-123");
		const hash2 = hashLockKey("account:user-123");
		expect(hash1).toBe(hash2);
	});

	it("produces different hashes for different inputs (usually)", () => {
		const hash1 = hashLockKey("account:user-123");
		const hash2 = hashLockKey("account:user-456");
		expect(hash1).not.toBe(hash2);
	});

	it("handles empty string", () => {
		const result = hashLockKey("");
		expect(typeof result).toBe("number");
		expect(result).toBe(0);
	});

	it("handles very long strings", () => {
		const longString = "a".repeat(10000);
		const result = hashLockKey(longString);
		expect(typeof result).toBe("number");
		expect(Number.isInteger(result)).toBe(true);
		expect(result).toBeGreaterThanOrEqual(-2147483648);
		expect(result).toBeLessThanOrEqual(2147483647);
	});

	it("handles strings with special characters", () => {
		const result = hashLockKey("account:user-123!@#$%^&*()");
		expect(typeof result).toBe("number");
		expect(Number.isInteger(result)).toBe(true);
	});

	it("handles single character strings", () => {
		const result = hashLockKey("a");
		expect(typeof result).toBe("number");
		expect(result).not.toBe(0);
	});
});
