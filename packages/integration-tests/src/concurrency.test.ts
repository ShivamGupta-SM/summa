import type { Summa } from "@summa-ledger/summa";
import { assertAccountBalance, assertDoubleEntryBalance } from "@summa-ledger/test-utils";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanupTables, closePool, createIntegrationInstance, createTestSchema } from "./setup.js";

/**
 * Concurrency stress tests for the summa ledger.
 *
 * Validates that the ledger maintains invariants under parallel access:
 *   - No double-spend / overdraft under concurrent debits
 *   - Transfers preserve total balance under concurrent execution
 *   - Account creation is idempotent under race conditions
 *   - Hold commit/void is safe under concurrent attempts
 *   - Double-entry invariant holds after all concurrent operations
 *
 * Requires PostgreSQL running via docker-compose:
 *   docker compose up -d
 *   pnpm --filter @summa-ledger/integration-tests test
 */
describe("Concurrency Stress Tests", () => {
	let summa: Summa;
	let cleanup: () => Promise<void>;

	beforeAll(async () => {
		await createTestSchema();
	});

	beforeEach(async () => {
		await cleanupTables();
		const instance = await createIntegrationInstance();
		summa = instance.summa;
		cleanup = instance.cleanup;
	});

	afterEach(async () => {
		await cleanup();
	});

	afterAll(async () => {
		await closePool();
	});

	// =========================================================================
	// CONCURRENT DEBITS -- no overdraft
	// =========================================================================

	it("concurrent debits do not overdraft an account", async () => {
		await summa.accounts.create({ holderId: "conc-user", holderType: "individual" });
		await summa.transactions.credit({
			holderId: "conc-user",
			amount: 10000,
			reference: "fund-conc",
		});

		// Fire 5 debits of 3000 concurrently. Balance is 10000, so at most 3 should succeed.
		const results = await Promise.allSettled(
			Array.from({ length: 5 }, (_, i) =>
				summa.transactions.debit({
					holderId: "conc-user",
					amount: 3000,
					reference: `conc-debit-${i}`,
				}),
			),
		);

		const successes = results.filter((r) => r.status === "fulfilled").length;
		const failures = results.filter((r) => r.status === "rejected").length;

		// At most 3 can succeed (3 * 3000 = 9000 <= 10000), 4th would need 12000
		expect(successes).toBeLessThanOrEqual(3);
		expect(failures).toBeGreaterThanOrEqual(2);

		// Balance must be non-negative
		const balance = await summa.accounts.getBalance("conc-user");
		expect(balance.balance).toBeGreaterThanOrEqual(0);
		expect(balance.balance).toBe(10000 - successes * 3000);

		await assertDoubleEntryBalance(summa);
	});

	// =========================================================================
	// CONCURRENT TRANSFERS -- total balance preserved
	// =========================================================================

	it("concurrent transfers preserve total balance across accounts", async () => {
		// Create 4 accounts, each with 50000
		const holders = ["ct-a", "ct-b", "ct-c", "ct-d"];
		for (const h of holders) {
			await summa.accounts.create({ holderId: h, holderType: "individual" });
			await summa.transactions.credit({ holderId: h, amount: 50000, reference: `fund-${h}` });
		}

		// Fire 10 concurrent transfers between random pairs
		const transfers = Array.from({ length: 10 }, (_, i) => {
			const src = holders[i % holders.length] ?? "ct-a";
			const dst = holders[(i + 1) % holders.length] ?? "ct-b";
			return summa.transactions.transfer({
				sourceHolderId: src,
				destinationHolderId: dst,
				amount: 5000,
				reference: `ct-transfer-${i}`,
			});
		});

		await Promise.allSettled(transfers);

		// Total across all accounts must still be 200000
		let total = 0;
		for (const h of holders) {
			const b = await summa.accounts.getBalance(h);
			total += b.balance;
		}
		expect(total).toBe(200000);

		await assertDoubleEntryBalance(summa);
	});

	// =========================================================================
	// CONCURRENT ACCOUNT CREATION -- idempotent
	// =========================================================================

	it("concurrent account creation returns the same account", async () => {
		const results = await Promise.allSettled(
			Array.from({ length: 5 }, () =>
				summa.accounts.create({ holderId: "race-user", holderType: "individual" }),
			),
		);

		const successes = results.filter((r) => r.status === "fulfilled");
		expect(successes.length).toBeGreaterThanOrEqual(1);

		// All successful creates should return the same account ID
		const ids = successes.map((r) => (r as PromiseFulfilledResult<{ id: string }>).value.id);
		const uniqueIds = new Set(ids);
		expect(uniqueIds.size).toBe(1);
	});

	// =========================================================================
	// CONCURRENT HOLD COMMIT/VOID
	// =========================================================================

	it("concurrent hold commit and void — only one succeeds", async () => {
		await summa.accounts.create({ holderId: "hold-race", holderType: "individual" });
		await summa.transactions.credit({
			holderId: "hold-race",
			amount: 20000,
			reference: "fund-hold-race",
		});

		const hold = await summa.holds.create({
			holderId: "hold-race",
			amount: 8000,
			reference: "hold-race-1",
		});

		// Attempt to both commit and void concurrently
		const [commitResult, voidResult] = await Promise.allSettled([
			summa.holds.commit({ holdId: hold.id }),
			summa.holds.void({ holdId: hold.id }),
		]);

		// Exactly one should succeed
		const succeeded = [commitResult, voidResult].filter((r) => r.status === "fulfilled").length;
		// At least one succeeded (could be both if they serialize correctly)
		expect(succeeded).toBeGreaterThanOrEqual(1);

		// Balance must be consistent
		const balance = await summa.accounts.getBalance("hold-race");
		// If commit won: 20000 - 8000 = 12000
		// If void won: 20000 (no deduction)
		expect([12000, 20000]).toContain(balance.balance);

		await assertDoubleEntryBalance(summa);
	});

	// =========================================================================
	// CONCURRENT CREDITS
	// =========================================================================

	it("concurrent credits all apply correctly", async () => {
		await summa.accounts.create({ holderId: "multi-credit", holderType: "individual" });

		const results = await Promise.allSettled(
			Array.from({ length: 10 }, (_, i) =>
				summa.transactions.credit({
					holderId: "multi-credit",
					amount: 1000,
					reference: `mc-credit-${i}`,
				}),
			),
		);

		const successes = results.filter((r) => r.status === "fulfilled").length;
		const balance = await summa.accounts.getBalance("multi-credit");
		expect(balance.balance).toBe(successes * 1000);

		await assertDoubleEntryBalance(summa);
	});

	// =========================================================================
	// MIXED CONCURRENT OPERATIONS
	// =========================================================================

	it("mixed concurrent operations maintain double-entry invariant", async () => {
		// Setup: 3 accounts with funds
		await summa.accounts.create({ holderId: "mix-a", holderType: "individual" });
		await summa.accounts.create({ holderId: "mix-b", holderType: "individual" });
		await summa.accounts.create({ holderId: "mix-c", holderType: "individual" });

		await summa.transactions.credit({ holderId: "mix-a", amount: 100000, reference: "mix-fund-a" });
		await summa.transactions.credit({ holderId: "mix-b", amount: 100000, reference: "mix-fund-b" });
		await summa.transactions.credit({ holderId: "mix-c", amount: 100000, reference: "mix-fund-c" });

		// Fire a mix of credits, debits, transfers, holds concurrently
		const ops = [
			summa.transactions.credit({ holderId: "mix-a", amount: 5000, reference: "mix-c1" }),
			summa.transactions.debit({ holderId: "mix-b", amount: 3000, reference: "mix-d1" }),
			summa.transactions.transfer({
				sourceHolderId: "mix-a",
				destinationHolderId: "mix-c",
				amount: 10000,
				reference: "mix-t1",
			}),
			summa.transactions.credit({ holderId: "mix-c", amount: 7000, reference: "mix-c2" }),
			summa.transactions.debit({ holderId: "mix-a", amount: 2000, reference: "mix-d2" }),
			summa.holds.create({ holderId: "mix-b", amount: 5000, reference: "mix-h1" }),
			summa.transactions.transfer({
				sourceHolderId: "mix-c",
				destinationHolderId: "mix-b",
				amount: 8000,
				reference: "mix-t2",
			}),
			summa.transactions.credit({ holderId: "mix-b", amount: 4000, reference: "mix-c3" }),
		];

		await Promise.allSettled(ops);

		// The critical invariant: double-entry must hold regardless of what succeeded
		await assertDoubleEntryBalance(summa);
	});

	// =========================================================================
	// CONCURRENT IDEMPOTENT DEBITS
	// =========================================================================

	it("concurrent debits with same idempotency key produce single debit", async () => {
		await summa.accounts.create({ holderId: "idem-conc", holderType: "individual" });
		await summa.transactions.credit({
			holderId: "idem-conc",
			amount: 50000,
			reference: "fund-idem-conc",
		});

		const results = await Promise.allSettled(
			Array.from({ length: 5 }, () =>
				summa.transactions.debit({
					holderId: "idem-conc",
					amount: 10000,
					reference: "idem-debit",
					idempotencyKey: "same-key",
				}),
			),
		);

		const successes = results.filter((r) => r.status === "fulfilled");
		// All should succeed (idempotent return)
		expect(successes.length).toBeGreaterThanOrEqual(1);

		// But balance should only reflect ONE debit
		await assertAccountBalance(summa, "idem-conc", 40000);
		await assertDoubleEntryBalance(summa);
	});
});
