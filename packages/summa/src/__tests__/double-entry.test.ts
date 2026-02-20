import type { SummaAdapter } from "@summa/core";
import { describe, expect, it, vi } from "vitest";
import { createSumma, type Summa } from "../index.js";

/**
 * Double-Entry Invariant Tests
 *
 * The fundamental invariant of double-entry bookkeeping:
 * For every posted transaction, sum of debit entries === sum of credit entries.
 *
 * These tests verify the Summa API shape and conceptual correctness.
 * Actual financial operation tests require PostgreSQL because the managers
 * use raw SQL internally (which memory adapter does not support).
 */
describe("Double-Entry Invariant", () => {
	/**
	 * Build a mock adapter that satisfies the SummaAdapter interface.
	 * All methods return empty/no-op results so that createSumma can
	 * construct the Summa instance without a real database.
	 */
	function createMockAdapter(): SummaAdapter {
		return {
			id: "mock-adapter",
			create: vi.fn().mockResolvedValue({}),
			findOne: vi.fn().mockResolvedValue(null),
			findMany: vi.fn().mockResolvedValue([]),
			update: vi.fn().mockResolvedValue(null),
			delete: vi.fn().mockResolvedValue(undefined),
			count: vi.fn().mockResolvedValue(0),
			transaction: vi.fn().mockImplementation((fn) =>
				fn({
					id: "mock-tx-adapter",
					create: vi.fn().mockResolvedValue({}),
					findOne: vi.fn().mockResolvedValue(null),
					findMany: vi.fn().mockResolvedValue([]),
					update: vi.fn().mockResolvedValue(null),
					delete: vi.fn().mockResolvedValue(undefined),
					count: vi.fn().mockResolvedValue(0),
					advisoryLock: vi.fn().mockResolvedValue(undefined),
					raw: vi.fn().mockResolvedValue([]),
					rawMutate: vi.fn().mockResolvedValue(0),
				}),
			),
			advisoryLock: vi.fn().mockResolvedValue(undefined),
			raw: vi.fn().mockResolvedValue([]),
			rawMutate: vi.fn().mockResolvedValue(0),
		};
	}

	it("createSumma returns correct interface shape", () => {
		const mockAdapter = createMockAdapter();
		const summa: Summa = createSumma({
			database: mockAdapter,
			logger: {
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
				debug: vi.fn(),
			},
		});

		// Verify all expected namespaces exist
		expect(summa.accounts).toBeDefined();
		expect(summa.transactions).toBeDefined();
		expect(summa.holds).toBeDefined();
		expect(summa.events).toBeDefined();
		expect(summa.limits).toBeDefined();
		expect(summa.workers).toBeDefined();
		expect(summa.$context).toBeInstanceOf(Promise);
		expect(summa.$options).toBeDefined();
	});

	it("accounts namespace has all expected methods", () => {
		const mockAdapter = createMockAdapter();
		const summa = createSumma({
			database: mockAdapter,
			logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
		});

		expect(typeof summa.accounts.create).toBe("function");
		expect(typeof summa.accounts.get).toBe("function");
		expect(typeof summa.accounts.getById).toBe("function");
		expect(typeof summa.accounts.getBalance).toBe("function");
		expect(typeof summa.accounts.freeze).toBe("function");
		expect(typeof summa.accounts.unfreeze).toBe("function");
		expect(typeof summa.accounts.close).toBe("function");
		expect(typeof summa.accounts.list).toBe("function");
	});

	it("transactions namespace has all expected methods", () => {
		const mockAdapter = createMockAdapter();
		const summa = createSumma({
			database: mockAdapter,
			logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
		});

		expect(typeof summa.transactions.credit).toBe("function");
		expect(typeof summa.transactions.debit).toBe("function");
		expect(typeof summa.transactions.transfer).toBe("function");
		expect(typeof summa.transactions.multiTransfer).toBe("function");
		expect(typeof summa.transactions.refund).toBe("function");
		expect(typeof summa.transactions.get).toBe("function");
		expect(typeof summa.transactions.list).toBe("function");
	});

	it("holds namespace has all expected methods", () => {
		const mockAdapter = createMockAdapter();
		const summa = createSumma({
			database: mockAdapter,
			logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
		});

		expect(typeof summa.holds.create).toBe("function");
		expect(typeof summa.holds.createMultiDest).toBe("function");
		expect(typeof summa.holds.commit).toBe("function");
		expect(typeof summa.holds.void).toBe("function");
		expect(typeof summa.holds.expireAll).toBe("function");
		expect(typeof summa.holds.get).toBe("function");
		expect(typeof summa.holds.listActive).toBe("function");
		expect(typeof summa.holds.listAll).toBe("function");
	});

	it("events namespace has all expected methods", () => {
		const mockAdapter = createMockAdapter();
		const summa = createSumma({
			database: mockAdapter,
			logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
		});

		expect(typeof summa.events.getForAggregate).toBe("function");
		expect(typeof summa.events.getByCorrelation).toBe("function");
		expect(typeof summa.events.verifyChain).toBe("function");
	});

	it("limits namespace has all expected methods", () => {
		const mockAdapter = createMockAdapter();
		const summa = createSumma({
			database: mockAdapter,
			logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
		});

		expect(typeof summa.limits.set).toBe("function");
		expect(typeof summa.limits.get).toBe("function");
		expect(typeof summa.limits.remove).toBe("function");
		expect(typeof summa.limits.getUsage).toBe("function");
	});

	it("workers namespace has start and stop methods", () => {
		const mockAdapter = createMockAdapter();
		const summa = createSumma({
			database: mockAdapter,
			logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
		});

		expect(typeof summa.workers.start).toBe("function");
		expect(typeof summa.workers.stop).toBe("function");
	});

	it("$options reflects the options passed to createSumma", () => {
		const mockAdapter = createMockAdapter();
		const options = {
			database: mockAdapter as any,
			currency: "EUR",
			logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
		};
		const summa = createSumma(options);

		expect(summa.$options).toBe(options);
		expect(summa.$options.currency).toBe("EUR");
	});

	// -------------------------------------------------------------------------
	// Financial operation tests -- these require PostgreSQL
	// -------------------------------------------------------------------------

	it.skip("credit increases balance, debit decreases balance (requires PostgreSQL)", async () => {
		// Requires PostgreSQL -- run with: pnpm test:integration
		// 1. Create an account
		// 2. Credit 10000 minor units
		// 3. Assert balance === 10000
		// 4. Debit 3000 minor units
		// 5. Assert balance === 7000
	});

	it.skip("transfer maintains total balance across accounts (requires PostgreSQL)", async () => {
		// Requires PostgreSQL -- run with: pnpm test:integration
		// 1. Create account A and account B
		// 2. Credit account A with 50000
		// 3. Transfer 20000 from A to B
		// 4. Assert A balance === 30000
		// 5. Assert B balance === 20000
		// 6. Assert total (A + B) === 50000 (conservation of money)
	});

	it.skip("sum of all debits equals sum of all credits globally (requires PostgreSQL)", async () => {
		// Requires PostgreSQL -- run with: pnpm test:integration
		// This is the core double-entry invariant:
		// SELECT SUM(amount) FROM entry WHERE type = 'debit'
		//   === SELECT SUM(amount) FROM entry WHERE type = 'credit'
		//
		// For every transaction posted, an equal debit and credit entry
		// pair must exist. The system should never allow an imbalance.
	});

	it.skip("overdraft prevention blocks debit when balance is insufficient (requires PostgreSQL)", async () => {
		// Requires PostgreSQL -- run with: pnpm test:integration
		// 1. Create an account with allowOverdraft = false
		// 2. Credit 5000
		// 3. Attempt to debit 10000
		// 4. Assert INSUFFICIENT_BALANCE error is thrown
		// 5. Assert balance is still 5000 (transaction rolled back)
	});

	it.skip("idempotency key prevents duplicate transactions (requires PostgreSQL)", async () => {
		// Requires PostgreSQL -- run with: pnpm test:integration
		// 1. Create an account, credit it
		// 2. Debit with idempotencyKey "key-1"
		// 3. Debit again with same idempotencyKey "key-1"
		// 4. Assert only one debit was applied
	});
});
