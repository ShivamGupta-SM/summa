import { SummaError } from "@summa/core";
import { assertAccountBalance, assertDoubleEntryBalance } from "@summa/test-utils";
import type { Summa } from "summa";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanupTables, closePool, createIntegrationInstance, createTestSchema } from "./setup.js";

/**
 * Hold lifecycle and expiry integration tests.
 *
 * Requires PostgreSQL running via docker-compose.
 */
describe("Hold Lifecycle Tests", () => {
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
	// HOLD CREATION
	// =========================================================================

	it("hold reduces available balance but not actual balance", async () => {
		await summa.accounts.create({ holderId: "h-user", holderType: "user" });
		await summa.transactions.credit({ holderId: "h-user", amount: 50000, reference: "h-fund" });

		const hold = await summa.holds.create({
			holderId: "h-user",
			amount: 20000,
			reference: "h-1",
		});

		expect(hold.id).toBeDefined();
		expect(hold.amount).toBe(20000);

		const balance = await summa.accounts.getBalance("h-user");
		expect(balance.balance).toBe(50000);
		expect(balance.availableBalance).toBe(30000);
	});

	it("multiple holds stack and reduce available balance", async () => {
		await summa.accounts.create({ holderId: "multi-h", holderType: "user" });
		await summa.transactions.credit({ holderId: "multi-h", amount: 30000, reference: "mh-fund" });

		await summa.holds.create({ holderId: "multi-h", amount: 10000, reference: "mh-1" });
		await summa.holds.create({ holderId: "multi-h", amount: 8000, reference: "mh-2" });

		const balance = await summa.accounts.getBalance("multi-h");
		expect(balance.balance).toBe(30000);
		expect(balance.availableBalance).toBe(12000); // 30000 - 10000 - 8000
	});

	it("hold creation fails if available balance is insufficient", async () => {
		await summa.accounts.create({ holderId: "poor-h", holderType: "user" });
		await summa.transactions.credit({ holderId: "poor-h", amount: 5000, reference: "ph-fund" });

		await expect(
			summa.holds.create({ holderId: "poor-h", amount: 10000, reference: "ph-1" }),
		).rejects.toThrow(SummaError);

		// Balance should be unchanged
		await assertAccountBalance(summa, "poor-h", 5000);
	});

	// =========================================================================
	// HOLD COMMIT
	// =========================================================================

	it("partial commit deducts only the committed amount", async () => {
		await summa.accounts.create({ holderId: "pc-user", holderType: "user" });
		await summa.transactions.credit({ holderId: "pc-user", amount: 30000, reference: "pc-fund" });

		const hold = await summa.holds.create({
			holderId: "pc-user",
			amount: 10000,
			reference: "pc-hold",
		});

		const result = await summa.holds.commit({ holdId: hold.id, amount: 6000 });
		expect(result.committedAmount).toBe(6000);
		expect(result.originalAmount).toBe(10000);

		// Balance: 30000 - 6000 = 24000 (only committed amount deducted)
		const balance = await summa.accounts.getBalance("pc-user");
		expect(balance.balance).toBe(24000);
		expect(balance.availableBalance).toBe(24000); // hold fully resolved

		await assertDoubleEntryBalance(summa);
	});

	it("full commit deducts the full hold amount", async () => {
		await summa.accounts.create({ holderId: "fc-user", holderType: "user" });
		await summa.transactions.credit({ holderId: "fc-user", amount: 20000, reference: "fc-fund" });

		const hold = await summa.holds.create({
			holderId: "fc-user",
			amount: 8000,
			reference: "fc-hold",
		});

		const result = await summa.holds.commit({ holdId: hold.id });
		expect(result.committedAmount).toBe(8000);

		await assertAccountBalance(summa, "fc-user", 12000);
		await assertDoubleEntryBalance(summa);
	});

	it("committing an already committed hold fails", async () => {
		await summa.accounts.create({ holderId: "dbl-commit", holderType: "user" });
		await summa.transactions.credit({
			holderId: "dbl-commit",
			amount: 20000,
			reference: "dc-fund",
		});

		const hold = await summa.holds.create({
			holderId: "dbl-commit",
			amount: 5000,
			reference: "dc-hold",
		});

		await summa.holds.commit({ holdId: hold.id });

		// Second commit should fail
		await expect(summa.holds.commit({ holdId: hold.id })).rejects.toThrow();
	});

	// =========================================================================
	// HOLD VOID
	// =========================================================================

	it("void releases held funds back to available balance", async () => {
		await summa.accounts.create({ holderId: "void-user", holderType: "user" });
		await summa.transactions.credit({
			holderId: "void-user",
			amount: 25000,
			reference: "v-fund",
		});

		const hold = await summa.holds.create({
			holderId: "void-user",
			amount: 10000,
			reference: "v-hold",
		});

		const balBefore = await summa.accounts.getBalance("void-user");
		expect(balBefore.availableBalance).toBe(15000);

		await summa.holds.void({ holdId: hold.id });

		const balAfter = await summa.accounts.getBalance("void-user");
		expect(balAfter.balance).toBe(25000);
		expect(balAfter.availableBalance).toBe(25000);
	});

	it("voiding an already voided hold fails", async () => {
		await summa.accounts.create({ holderId: "dbl-void", holderType: "user" });
		await summa.transactions.credit({
			holderId: "dbl-void",
			amount: 15000,
			reference: "dv-fund",
		});

		const hold = await summa.holds.create({
			holderId: "dbl-void",
			amount: 5000,
			reference: "dv-hold",
		});

		await summa.holds.void({ holdId: hold.id });
		await expect(summa.holds.void({ holdId: hold.id })).rejects.toThrow();
	});

	// =========================================================================
	// HOLD EXPIRY
	// =========================================================================

	it("expireAll expires holds past their expiration", async () => {
		await summa.accounts.create({ holderId: "exp-user", holderType: "user" });
		await summa.transactions.credit({
			holderId: "exp-user",
			amount: 50000,
			reference: "exp-fund",
		});

		// Create a hold with immediate expiry (0 minutes = expires NOW)
		const ctx = await summa.$context;
		await summa.holds.create({
			holderId: "exp-user",
			amount: 10000,
			reference: "exp-hold",
			expiresInMinutes: 0,
		});

		// Manually backdate the hold_expires_at to the past
		await ctx.adapter.rawMutate(
			`UPDATE transaction_record
			 SET hold_expires_at = NOW() - INTERVAL '1 hour'
			 WHERE reference = 'exp-hold'`,
			[],
		);

		const result = await summa.holds.expireAll();
		expect(result.expired).toBeGreaterThanOrEqual(1);

		// Funds should be released
		const balance = await summa.accounts.getBalance("exp-user");
		expect(balance.availableBalance).toBe(50000);

		await assertDoubleEntryBalance(summa);
	});

	// =========================================================================
	// MULTI-DESTINATION HOLDS
	// =========================================================================

	it("multi-destination hold splits on commit", async () => {
		await summa.accounts.create({ holderId: "md-payer", holderType: "user" });
		await summa.accounts.create({ holderId: "md-seller", holderType: "user" });
		await summa.accounts.create({ holderId: "md-platform", holderType: "user" });

		await summa.transactions.credit({
			holderId: "md-payer",
			amount: 100000,
			reference: "md-fund",
		});

		const hold = await summa.holds.createMultiDest({
			holderId: "md-payer",
			amount: 50000,
			reference: "md-hold",
			destinations: [
				{ holderId: "md-seller", amount: 47500 },
				{ holderId: "md-platform", amount: 2500 },
			],
		});

		expect(hold.amount).toBe(50000);

		// Before commit: available = 100000 - 50000 = 50000
		const balBefore = await summa.accounts.getBalance("md-payer");
		expect(balBefore.availableBalance).toBe(50000);

		// Commit
		await summa.holds.commit({ holdId: hold.id });

		await assertAccountBalance(summa, "md-payer", 50000);
		await assertAccountBalance(summa, "md-seller", 47500);
		await assertAccountBalance(summa, "md-platform", 2500);

		await assertDoubleEntryBalance(summa);
	});

	// =========================================================================
	// HOLD LISTING
	// =========================================================================

	it("listActive returns only inflight holds", async () => {
		await summa.accounts.create({ holderId: "list-h", holderType: "user" });
		await summa.transactions.credit({
			holderId: "list-h",
			amount: 100000,
			reference: "lh-fund",
		});

		const h1 = await summa.holds.create({
			holderId: "list-h",
			amount: 5000,
			reference: "lh-1",
		});
		await summa.holds.create({ holderId: "list-h", amount: 3000, reference: "lh-2" });
		await summa.holds.create({ holderId: "list-h", amount: 2000, reference: "lh-3" });

		// Void one
		await summa.holds.void({ holdId: h1.id });

		const active = await summa.holds.listActive({ holderId: "list-h" });
		expect(active.holds.length).toBe(2);
	});

	it("listAll returns holds in all statuses", async () => {
		await summa.accounts.create({ holderId: "all-h", holderType: "user" });
		await summa.transactions.credit({
			holderId: "all-h",
			amount: 100000,
			reference: "ah-fund",
		});

		const h1 = await summa.holds.create({
			holderId: "all-h",
			amount: 5000,
			reference: "ah-1",
		});
		const h2 = await summa.holds.create({
			holderId: "all-h",
			amount: 3000,
			reference: "ah-2",
		});
		await summa.holds.create({ holderId: "all-h", amount: 2000, reference: "ah-3" });

		await summa.holds.commit({ holdId: h1.id });
		await summa.holds.void({ holdId: h2.id });

		const all = await summa.holds.listAll({ holderId: "all-h" });
		expect(all.holds.length).toBe(3);
	});

	// =========================================================================
	// GET HOLD
	// =========================================================================

	it("get hold by ID returns correct hold", async () => {
		await summa.accounts.create({ holderId: "get-h", holderType: "user" });
		await summa.transactions.credit({
			holderId: "get-h",
			amount: 20000,
			reference: "gh-fund",
		});

		const hold = await summa.holds.create({
			holderId: "get-h",
			amount: 7000,
			reference: "gh-hold",
		});

		const fetched = await summa.holds.get(hold.id);
		expect(fetched.id).toBe(hold.id);
		expect(fetched.amount).toBe(7000);
	});

	// =========================================================================
	// HOLDS + DOUBLE ENTRY
	// =========================================================================

	it("complex hold scenario maintains double-entry invariant", async () => {
		await summa.accounts.create({ holderId: "complex-a", holderType: "user" });
		await summa.accounts.create({ holderId: "complex-b", holderType: "user" });

		await summa.transactions.credit({
			holderId: "complex-a",
			amount: 80000,
			reference: "cx-fund",
		});

		// Create 3 holds
		const h1 = await summa.holds.create({
			holderId: "complex-a",
			amount: 20000,
			reference: "cx-h1",
		});
		const h2 = await summa.holds.create({
			holderId: "complex-a",
			amount: 15000,
			reference: "cx-h2",
		});
		const h3 = await summa.holds.create({
			holderId: "complex-a",
			amount: 10000,
			reference: "cx-h3",
		});

		// Commit first with partial amount
		await summa.holds.commit({ holdId: h1.id, amount: 12000 });
		// Void second
		await summa.holds.void({ holdId: h2.id });
		// Full commit third
		await summa.holds.commit({ holdId: h3.id });

		// Balance: 80000 - 12000 - 10000 = 58000
		await assertAccountBalance(summa, "complex-a", 58000);
		await assertDoubleEntryBalance(summa);
	});
});
