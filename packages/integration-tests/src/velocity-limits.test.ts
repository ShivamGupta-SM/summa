import { SummaError } from "@summa-ledger/core";
import type { Summa } from "@summa-ledger/summa";
import { assertDoubleEntryBalance } from "@summa-ledger/test-utils";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanupTables, closePool, createIntegrationInstance, createTestSchema } from "./setup.js";

/**
 * Velocity limits integration tests.
 *
 * Tests the limit-manager and velocity-limits plugin behavior
 * against a real PostgreSQL database.
 */
describe("Velocity Limits Integration Tests", () => {
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
	// PER-TRANSACTION LIMITS
	// =========================================================================

	it("per-transaction limit blocks oversized debit", async () => {
		await summa.accounts.create({ holderId: "lim-user", holderType: "individual" });
		await summa.transactions.credit({
			holderId: "lim-user",
			amount: 100000,
			reference: "lim-fund",
		});

		await summa.limits.set({
			holderId: "lim-user",
			limitType: "per_transaction",
			maxAmount: 5000,
		});

		// Small debit should work
		await summa.transactions.debit({
			holderId: "lim-user",
			amount: 3000,
			reference: "lim-d1",
		});

		// Oversized debit should fail
		try {
			await summa.transactions.debit({
				holderId: "lim-user",
				amount: 6000,
				reference: "lim-d2",
			});
			expect.unreachable("Should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(SummaError);
			expect((err as SummaError).code).toBe("LIMIT_EXCEEDED");
		}

		await assertDoubleEntryBalance(summa);
	});

	it("per-transaction limit blocks oversized credit", async () => {
		await summa.accounts.create({ holderId: "lim-credit", holderType: "individual" });

		await summa.limits.set({
			holderId: "lim-credit",
			limitType: "per_transaction",
			maxAmount: 10000,
		});

		// Within limit
		await summa.transactions.credit({
			holderId: "lim-credit",
			amount: 8000,
			reference: "lim-c1",
		});

		// Over limit
		await expect(
			summa.transactions.credit({
				holderId: "lim-credit",
				amount: 15000,
				reference: "lim-c2",
			}),
		).rejects.toThrow(SummaError);
	});

	// =========================================================================
	// DAILY LIMITS
	// =========================================================================

	it("daily limit blocks when cumulative usage exceeds threshold", async () => {
		await summa.accounts.create({ holderId: "daily-user", holderType: "individual" });
		await summa.transactions.credit({
			holderId: "daily-user",
			amount: 500000,
			reference: "daily-fund",
		});

		await summa.limits.set({
			holderId: "daily-user",
			limitType: "daily",
			maxAmount: 10000,
		});

		// First debit: 7000 (within daily limit)
		await summa.transactions.debit({
			holderId: "daily-user",
			amount: 7000,
			reference: "daily-d1",
		});

		// Second debit: 5000 would bring daily total to 12000 > 10000
		try {
			await summa.transactions.debit({
				holderId: "daily-user",
				amount: 5000,
				reference: "daily-d2",
			});
			expect.unreachable("Should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(SummaError);
			expect((err as SummaError).code).toBe("LIMIT_EXCEEDED");
		}

		// But a small debit that fits should work
		await summa.transactions.debit({
			holderId: "daily-user",
			amount: 2000,
			reference: "daily-d3",
		});

		await assertDoubleEntryBalance(summa);
	});

	// =========================================================================
	// MONTHLY LIMITS
	// =========================================================================

	it("monthly limit blocks when cumulative usage exceeds threshold", async () => {
		await summa.accounts.create({ holderId: "monthly-user", holderType: "individual" });
		await summa.transactions.credit({
			holderId: "monthly-user",
			amount: 500000,
			reference: "monthly-fund",
		});

		await summa.limits.set({
			holderId: "monthly-user",
			limitType: "monthly",
			maxAmount: 20000,
		});

		// Debit 15000
		await summa.transactions.debit({
			holderId: "monthly-user",
			amount: 15000,
			reference: "monthly-d1",
		});

		// Debit 10000 would bring monthly to 25000 > 20000
		await expect(
			summa.transactions.debit({
				holderId: "monthly-user",
				amount: 10000,
				reference: "monthly-d2",
			}),
		).rejects.toThrow(SummaError);
	});

	// =========================================================================
	// LIMIT MANAGEMENT CRUD
	// =========================================================================

	it("set, get, and remove limits", async () => {
		await summa.accounts.create({ holderId: "crud-lim", holderType: "individual" });

		// Set two limits
		const ptLimit = await summa.limits.set({
			holderId: "crud-lim",
			limitType: "per_transaction",
			maxAmount: 5000,
		});
		expect(ptLimit.limitType).toBe("per_transaction");
		expect(ptLimit.maxAmount).toBe(5000);

		await summa.limits.set({
			holderId: "crud-lim",
			limitType: "daily",
			maxAmount: 50000,
		});

		// Get all limits
		const limits = await summa.limits.get("crud-lim");
		expect(limits.length).toBe(2);

		// Remove per_transaction limit
		await summa.limits.remove({
			holderId: "crud-lim",
			limitType: "per_transaction",
		});

		const remaining = await summa.limits.get("crud-lim");
		expect(remaining.length).toBe(1);
		expect(remaining[0]?.limitType).toBe("daily");
	});

	it("updating a limit changes the maxAmount via upsert", async () => {
		await summa.accounts.create({ holderId: "upsert-lim", holderType: "individual" });

		await summa.limits.set({
			holderId: "upsert-lim",
			limitType: "per_transaction",
			maxAmount: 5000,
		});

		// Update same limit type
		const updated = await summa.limits.set({
			holderId: "upsert-lim",
			limitType: "per_transaction",
			maxAmount: 10000,
		});

		expect(updated.maxAmount).toBe(10000);

		// Should still be just 1 limit
		const limits = await summa.limits.get("upsert-lim");
		expect(limits.length).toBe(1);
	});

	// =========================================================================
	// USAGE TRACKING
	// =========================================================================

	it("getUsage returns correct daily and monthly totals", async () => {
		await summa.accounts.create({ holderId: "usage-user", holderType: "individual" });
		await summa.transactions.credit({
			holderId: "usage-user",
			amount: 100000,
			reference: "usage-fund",
		});

		await summa.transactions.debit({ holderId: "usage-user", amount: 3000, reference: "u-d1" });
		await summa.transactions.debit({ holderId: "usage-user", amount: 5000, reference: "u-d2" });

		const usage = await summa.limits.getUsage({
			holderId: "usage-user",
			txnType: "debit",
		});

		// Both debits happened "today" so daily and monthly should be same
		expect(usage.daily).toBe(8000);
		expect(usage.monthly).toBe(8000);
	});

	// =========================================================================
	// CATEGORY-SCOPED LIMITS
	// =========================================================================

	it("category-scoped limit only applies to matching transactions", async () => {
		await summa.accounts.create({ holderId: "cat-user", holderType: "individual" });
		await summa.transactions.credit({
			holderId: "cat-user",
			amount: 500000,
			reference: "cat-fund",
		});

		// Set per_transaction limit only for "withdrawal" category
		await summa.limits.set({
			holderId: "cat-user",
			limitType: "per_transaction",
			maxAmount: 5000,
			category: "withdrawal",
		});

		// Generic debit (no category) should NOT be limited
		await summa.transactions.debit({
			holderId: "cat-user",
			amount: 20000,
			reference: "cat-d1",
		});

		// Categorized debit within limit should work
		await summa.transactions.debit({
			holderId: "cat-user",
			amount: 4000,
			reference: "cat-d2",
			category: "withdrawal",
		});

		// Categorized debit over limit should fail
		await expect(
			summa.transactions.debit({
				holderId: "cat-user",
				amount: 6000,
				reference: "cat-d3",
				category: "withdrawal",
			}),
		).rejects.toThrow(SummaError);

		await assertDoubleEntryBalance(summa);
	});

	// =========================================================================
	// LIMIT DOES NOT AFFECT TRANSFER TARGET
	// =========================================================================

	it("transfer respects source account limits", async () => {
		await summa.accounts.create({ holderId: "lim-src", holderType: "individual" });
		await summa.accounts.create({ holderId: "lim-dst", holderType: "individual" });
		await summa.transactions.credit({ holderId: "lim-src", amount: 100000, reference: "lt-fund" });

		await summa.limits.set({
			holderId: "lim-src",
			limitType: "per_transaction",
			maxAmount: 5000,
		});

		// Transfer over limit should fail
		await expect(
			summa.transactions.transfer({
				sourceHolderId: "lim-src",
				destinationHolderId: "lim-dst",
				amount: 10000,
				reference: "lt-t1",
			}),
		).rejects.toThrow(SummaError);

		// Transfer within limit should succeed
		await summa.transactions.transfer({
			sourceHolderId: "lim-src",
			destinationHolderId: "lim-dst",
			amount: 4000,
			reference: "lt-t2",
		});

		await assertDoubleEntryBalance(summa);
	});
});
