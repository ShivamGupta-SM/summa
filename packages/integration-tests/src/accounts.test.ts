import { SummaError } from "@summa-ledger/core";
import type { Summa } from "@summa-ledger/summa";
import { assertAccountBalance, assertDoubleEntryBalance } from "@summa-ledger/test-utils";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanupTables, closePool, createIntegrationInstance, createTestSchema } from "./setup.js";

/**
 * Account lifecycle integration tests.
 *
 * Requires PostgreSQL running via docker-compose.
 */
describe("Account Lifecycle Tests", () => {
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
	// ACCOUNT CREATION
	// =========================================================================

	it("creates an account and retrieves it by holderId", async () => {
		const account = await summa.accounts.create({
			holderId: "test-user",
			holderType: "individual",
		});

		expect(account.id).toBeDefined();
		expect(account.holderId).toBe("test-user");
		expect(account.holderType).toBe("individual");
		expect(account.status).toBe("active");

		const fetched = await summa.accounts.get("test-user");
		expect(fetched.id).toBe(account.id);
	});

	it("creates an account with metadata", async () => {
		const account = await summa.accounts.create({
			holderId: "meta-user",
			holderType: "individual",
			metadata: { tier: "gold", region: "US" },
		});

		expect(account.metadata).toEqual({ tier: "gold", region: "US" });
	});

	it("duplicate account creation returns existing account", async () => {
		const first = await summa.accounts.create({
			holderId: "dup-user",
			holderType: "individual",
		});
		const second = await summa.accounts.create({
			holderId: "dup-user",
			holderType: "individual",
		});

		expect(first.id).toBe(second.id);
	});

	it("rejects empty holderId", async () => {
		await expect(summa.accounts.create({ holderId: "", holderType: "individual" })).rejects.toThrow(
			SummaError,
		);
	});

	// =========================================================================
	// GET BY ID
	// =========================================================================

	it("retrieves account by internal UUID", async () => {
		const account = await summa.accounts.create({
			holderId: "id-user",
			holderType: "individual",
		});

		const fetched = await summa.accounts.getById(account.id);
		expect(fetched.holderId).toBe("id-user");
	});

	it("throws NOT_FOUND for non-existent holderId", async () => {
		try {
			await summa.accounts.get("nonexistent");
			expect.unreachable("Should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(SummaError);
			expect((err as SummaError).code).toBe("NOT_FOUND");
		}
	});

	// =========================================================================
	// BALANCE
	// =========================================================================

	it("new account has zero balance", async () => {
		await summa.accounts.create({ holderId: "zero-user", holderType: "individual" });
		const balance = await summa.accounts.getBalance("zero-user");
		expect(balance.balance).toBe(0);
		expect(balance.availableBalance).toBe(0);
	});

	it("balance reflects credits and debits correctly", async () => {
		await summa.accounts.create({ holderId: "bal-user", holderType: "individual" });
		await summa.transactions.credit({ holderId: "bal-user", amount: 25000, reference: "c1" });
		await summa.transactions.debit({ holderId: "bal-user", amount: 10000, reference: "d1" });

		const balance = await summa.accounts.getBalance("bal-user");
		expect(balance.balance).toBe(15000);
		expect(balance.creditBalance).toBe(25000);
		expect(balance.debitBalance).toBe(10000);
	});

	// =========================================================================
	// FREEZE / UNFREEZE
	// =========================================================================

	it("frozen account rejects credits", async () => {
		await summa.accounts.create({ holderId: "frz-credit", holderType: "individual" });
		await summa.accounts.freeze({
			holderId: "frz-credit",
			reason: "fraud",
			frozenBy: "admin",
		});

		try {
			await summa.transactions.credit({
				holderId: "frz-credit",
				amount: 5000,
				reference: "frz-c1",
			});
			expect.unreachable("Should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(SummaError);
			expect((err as SummaError).code).toBe("ACCOUNT_FROZEN");
		}
	});

	it("frozen account rejects transfers out", async () => {
		await summa.accounts.create({ holderId: "frz-src", holderType: "individual" });
		await summa.accounts.create({ holderId: "frz-dst", holderType: "individual" });
		await summa.transactions.credit({ holderId: "frz-src", amount: 20000, reference: "frz-fund" });

		await summa.accounts.freeze({
			holderId: "frz-src",
			reason: "compliance",
			frozenBy: "system",
		});

		await expect(
			summa.transactions.transfer({
				sourceHolderId: "frz-src",
				destinationHolderId: "frz-dst",
				amount: 5000,
				reference: "frz-transfer",
			}),
		).rejects.toThrow(SummaError);
	});

	it("frozen account rejects hold creation", async () => {
		await summa.accounts.create({ holderId: "frz-hold", holderType: "individual" });
		await summa.transactions.credit({ holderId: "frz-hold", amount: 10000, reference: "frz-hf" });

		await summa.accounts.freeze({
			holderId: "frz-hold",
			reason: "review",
			frozenBy: "admin",
		});

		await expect(
			summa.holds.create({
				holderId: "frz-hold",
				amount: 5000,
				reference: "frz-hold-1",
			}),
		).rejects.toThrow(SummaError);
	});

	it("unfreeze restores account operations", async () => {
		await summa.accounts.create({ holderId: "unfrz", holderType: "individual" });
		await summa.accounts.freeze({ holderId: "unfrz", reason: "temp", frozenBy: "admin" });
		await summa.accounts.unfreeze({ holderId: "unfrz", unfrozenBy: "admin" });

		// Should now work
		await summa.transactions.credit({ holderId: "unfrz", amount: 5000, reference: "unfrz-c1" });
		await assertAccountBalance(summa, "unfrz", 5000);
	});

	// =========================================================================
	// CLOSE ACCOUNT
	// =========================================================================

	it("closed account rejects all operations", async () => {
		await summa.accounts.create({ holderId: "close-user", holderType: "individual" });
		await summa.accounts.close({ holderId: "close-user", closedBy: "admin", reason: "inactive" });

		try {
			await summa.transactions.credit({
				holderId: "close-user",
				amount: 1000,
				reference: "post-close",
			});
			expect.unreachable("Should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(SummaError);
			expect((err as SummaError).code).toBe("ACCOUNT_CLOSED");
		}
	});

	it("close with sweep transfers remaining balance", async () => {
		await summa.accounts.create({ holderId: "sweep-src", holderType: "individual" });
		await summa.accounts.create({ holderId: "sweep-dst", holderType: "individual" });

		await summa.transactions.credit({
			holderId: "sweep-src",
			amount: 15000,
			reference: "sweep-fund",
		});

		await summa.accounts.close({
			holderId: "sweep-src",
			closedBy: "admin",
			transferToHolderId: "sweep-dst",
		});

		// Source is closed with zero balance
		const srcBal = await summa.accounts.getBalance("sweep-src");
		expect(srcBal.balance).toBe(0);

		// Destination received the funds
		await assertAccountBalance(summa, "sweep-dst", 15000);
		await assertDoubleEntryBalance(summa);
	});

	// =========================================================================
	// LIST ACCOUNTS
	// =========================================================================

	it("lists accounts with pagination", async () => {
		// Create 5 accounts
		for (let i = 0; i < 5; i++) {
			await summa.accounts.create({ holderId: `list-user-${i}`, holderType: "individual" });
		}

		const page1 = await summa.accounts.list({ page: 1, perPage: 3 });
		expect(page1.accounts.length).toBe(3);
		expect(page1.hasMore).toBe(true);
		expect(page1.total).toBe(5);

		const page2 = await summa.accounts.list({ page: 2, perPage: 3 });
		expect(page2.accounts.length).toBe(2);
		expect(page2.hasMore).toBe(false);
	});

	it("lists accounts filtered by status", async () => {
		await summa.accounts.create({ holderId: "status-active", holderType: "individual" });
		await summa.accounts.create({ holderId: "status-frozen", holderType: "individual" });
		await summa.accounts.freeze({
			holderId: "status-frozen",
			reason: "test",
			frozenBy: "admin",
		});

		const activeOnly = await summa.accounts.list({ status: "active" });
		const allHolderIds = activeOnly.accounts.map((a) => a.holderId);
		expect(allHolderIds).toContain("status-active");
		expect(allHolderIds).not.toContain("status-frozen");
	});

	// =========================================================================
	// ACCOUNT INDICATOR
	// =========================================================================

	it("creates account with unique indicator", async () => {
		const account = await summa.accounts.create({
			holderId: "ind-user",
			holderType: "individual",
			indicator: "ACC-001",
		});
		expect(account.indicator).toBe("ACC-001");
	});
});
