import { describe, expect, it } from "vitest";
import { computeHash } from "../utils/hash.js";

describe("computeHash", () => {
	it("produces deterministic output (same inputs produce same hash)", () => {
		const data = { type: "credit", amount: 100, currency: "USD" };
		const hash1 = computeHash("prev-hash-abc", data);
		const hash2 = computeHash("prev-hash-abc", data);
		expect(hash1).toBe(hash2);
	});

	it("produces different hashes for different event data", () => {
		const data1 = { type: "credit", amount: 100 };
		const data2 = { type: "debit", amount: 100 };
		const hash1 = computeHash("prev", data1);
		const hash2 = computeHash("prev", data2);
		expect(hash1).not.toBe(hash2);
	});

	it("produces different hashes for different prevHash values", () => {
		const data = { type: "credit", amount: 100 };
		const hash1 = computeHash("prev-1", data);
		const hash2 = computeHash("prev-2", data);
		expect(hash1).not.toBe(hash2);
	});

	it("handles null prevHash (genesis event)", () => {
		const data = { type: "account_created", holderId: "user-1" };
		const hash = computeHash(null, data);
		expect(hash).toBeDefined();
		expect(typeof hash).toBe("string");
		expect(hash).toHaveLength(64);
	});

	it("returns a 64-character hex string (SHA-256)", () => {
		const data = { type: "credit", amount: 500 };
		const hash = computeHash("some-prev-hash", data);
		expect(hash).toHaveLength(64);
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
	});

	it("produces same hash regardless of key ordering (deterministic serialization)", () => {
		const data1 = { type: "credit", amount: 100, currency: "USD" };
		const data2 = { currency: "USD", amount: 100, type: "credit" };
		const hash1 = computeHash("prev", data1);
		const hash2 = computeHash("prev", data2);
		expect(hash1).toBe(hash2);
	});

	it("handles nested objects deterministically", () => {
		const data1 = {
			type: "credit",
			metadata: { source: "api", details: { ip: "127.0.0.1" } },
		};
		const data2 = {
			metadata: { details: { ip: "127.0.0.1" }, source: "api" },
			type: "credit",
		};
		const hash1 = computeHash(null, data1);
		const hash2 = computeHash(null, data2);
		expect(hash1).toBe(hash2);
	});

	it("handles JSONB round-trip normalization (undefined values are stripped)", () => {
		// JSON.parse(JSON.stringify({a: undefined})) => {} -- undefined is stripped
		const dataWithUndefined = { type: "credit", extra: undefined } as Record<string, unknown>;
		const dataWithout = { type: "credit" };
		const hash1 = computeHash("prev", dataWithUndefined);
		const hash2 = computeHash("prev", dataWithout);
		expect(hash1).toBe(hash2);
	});

	it("handles empty object", () => {
		const hash = computeHash(null, {});
		expect(hash).toHaveLength(64);
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
	});

	it("null prevHash and empty string prevHash produce the same hash", () => {
		const data = { type: "test" };
		const hashNull = computeHash(null, data);
		const hashEmpty = computeHash("", data);
		// Both use "" as the prevHash portion, so they should be equal
		// null ?? "" => "", so computeHash(null, data) === computeHash("", data)
		expect(hashNull).toBe(hashEmpty);
	});
});
