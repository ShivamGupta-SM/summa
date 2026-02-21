import { SummaError } from "@summa/core";
import { assertAccountBalance, assertDoubleEntryBalance } from "@summa/test-utils";
import type { Summa } from "summa";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanupTables, closePool, createIntegrationInstance, createTestSchema } from "./setup.js";

/**
 * Integration tests for the summa ledger.
 *
 * Requires PostgreSQL running via docker-compose:
 *   docker compose up -d
 *   pnpm --filter @summa/integration-tests test
 */
describe("Ledger Integration Tests", () => {
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
	// CREDIT / DEBIT
	// =========================================================================

	it("credit increases balance, debit decreases balance", async () => {
		await summa.accounts.create({ holderId: "user-1", holderType: "individual" });

		await summa.transactions.credit({
			holderId: "user-1",
			amount: 10000,
			reference: "credit-1",
		});

		const b1 = await summa.accounts.getBalance("user-1");
		expect(b1.balance).toBe(10000);

		await summa.transactions.debit({
			holderId: "user-1",
			amount: 3000,
			reference: "debit-1",
		});

		const b2 = await summa.accounts.getBalance("user-1");
		expect(b2.balance).toBe(7000);
	});

	// =========================================================================
	// TRANSFER
	// =========================================================================

	it("transfer maintains total balance across accounts", async () => {
		await summa.accounts.create({ holderId: "alice", holderType: "individual" });
		await summa.accounts.create({ holderId: "bob", holderType: "individual" });

		await summa.transactions.credit({
			holderId: "alice",
			amount: 50000,
			reference: "fund-alice",
		});

		await summa.transactions.transfer({
			sourceHolderId: "alice",
			destinationHolderId: "bob",
			amount: 20000,
			reference: "transfer-1",
		});

		const aliceBalance = await summa.accounts.getBalance("alice");
		const bobBalance = await summa.accounts.getBalance("bob");

		expect(aliceBalance.balance).toBe(30000);
		expect(bobBalance.balance).toBe(20000);
		expect(aliceBalance.balance + bobBalance.balance).toBe(50000);
	});

	// =========================================================================
	// DOUBLE-ENTRY INVARIANT
	// =========================================================================

	it("sum of all debits equals sum of all credits globally", async () => {
		await summa.accounts.create({ holderId: "u1", holderType: "individual" });
		await summa.accounts.create({ holderId: "u2", holderType: "individual" });

		await summa.transactions.credit({ holderId: "u1", amount: 100000, reference: "c-1" });
		await summa.transactions.credit({ holderId: "u2", amount: 50000, reference: "c-2" });
		await summa.transactions.transfer({
			sourceHolderId: "u1",
			destinationHolderId: "u2",
			amount: 25000,
			reference: "t-1",
		});
		await summa.transactions.debit({ holderId: "u2", amount: 10000, reference: "d-1" });

		// Per-transaction invariant: query entry_record
		const ctx = await summa.$context;
		const rows = await ctx.adapter.raw<{
			transaction_id: string;
			total_credits: number;
			total_debits: number;
		}>(
			`SELECT
				e.transaction_id,
				SUM(CASE WHEN e.entry_type = 'CREDIT' THEN e.amount ELSE 0 END) AS total_credits,
				SUM(CASE WHEN e.entry_type = 'DEBIT' THEN e.amount ELSE 0 END) AS total_debits
			 FROM entry_record e
			 GROUP BY e.transaction_id
			 HAVING SUM(CASE WHEN e.entry_type = 'CREDIT' THEN e.amount ELSE 0 END)
			     != SUM(CASE WHEN e.entry_type = 'DEBIT' THEN e.amount ELSE 0 END)`,
			[],
		);

		expect(rows).toHaveLength(0);

		// Global invariant: user + system + hot = 0
		await assertDoubleEntryBalance(summa);
	});

	// =========================================================================
	// OVERDRAFT PREVENTION
	// =========================================================================

	it("overdraft prevention blocks debit when balance is insufficient", async () => {
		await summa.accounts.create({ holderId: "poor-user", holderType: "individual" });
		await summa.transactions.credit({
			holderId: "poor-user",
			amount: 5000,
			reference: "small-credit",
		});

		await expect(
			summa.transactions.debit({
				holderId: "poor-user",
				amount: 10000,
				reference: "big-debit",
			}),
		).rejects.toThrow(SummaError);

		// Balance should remain unchanged
		await assertAccountBalance(summa, "poor-user", 5000);
	});

	// =========================================================================
	// IDEMPOTENCY
	// =========================================================================

	it("idempotency key prevents duplicate transactions", async () => {
		await summa.accounts.create({ holderId: "idem-user", holderType: "individual" });
		await summa.transactions.credit({
			holderId: "idem-user",
			amount: 50000,
			reference: "fund-idem",
		});

		// First debit
		const txn1 = await summa.transactions.debit({
			holderId: "idem-user",
			amount: 10000,
			reference: "debit-idem-1",
			idempotencyKey: "key-1",
		});

		// Same idempotency key — should return same result, NOT double-debit
		const txn2 = await summa.transactions.debit({
			holderId: "idem-user",
			amount: 10000,
			reference: "debit-idem-2",
			idempotencyKey: "key-1",
		});

		expect(txn1.id).toBe(txn2.id);

		// Balance should show only ONE debit
		await assertAccountBalance(summa, "idem-user", 40000);
	});

	// =========================================================================
	// HOLDS
	// =========================================================================

	it("hold freezes funds, commit deducts, void releases", async () => {
		await summa.accounts.create({ holderId: "hold-user", holderType: "individual" });
		await summa.transactions.credit({
			holderId: "hold-user",
			amount: 20000,
			reference: "fund-hold",
		});

		// Place hold
		const hold = await summa.holds.create({
			holderId: "hold-user",
			amount: 8000,
			reference: "hold-1",
		});

		// Balance unchanged, but available balance reduced
		const b1 = await summa.accounts.getBalance("hold-user");
		expect(b1.balance).toBe(20000);
		expect(b1.availableBalance).toBe(12000); // 20000 - 8000 pending

		// Commit the hold
		await summa.holds.commit({ holdId: hold.id });

		const b2 = await summa.accounts.getBalance("hold-user");
		expect(b2.balance).toBe(12000); // 20000 - 8000
		expect(b2.availableBalance).toBe(12000);

		// Double-entry still holds
		await assertDoubleEntryBalance(summa);
	});

	it("voiding a hold releases the pending amount", async () => {
		await summa.accounts.create({ holderId: "void-user", holderType: "individual" });
		await summa.transactions.credit({
			holderId: "void-user",
			amount: 15000,
			reference: "fund-void",
		});

		const hold = await summa.holds.create({
			holderId: "void-user",
			amount: 5000,
			reference: "hold-void",
		});

		await summa.holds.void({ holdId: hold.id });

		const b = await summa.accounts.getBalance("void-user");
		expect(b.balance).toBe(15000);
		expect(b.availableBalance).toBe(15000);
	});

	// =========================================================================
	// MULTI-TRANSFER
	// =========================================================================

	it("multiTransfer splits amount atomically to multiple destinations", async () => {
		await summa.accounts.create({ holderId: "payer", holderType: "individual" });
		await summa.accounts.create({ holderId: "seller", holderType: "individual" });
		await summa.accounts.create({ holderId: "platform", holderType: "individual" });

		await summa.transactions.credit({
			holderId: "payer",
			amount: 100000,
			reference: "fund-payer",
		});

		await summa.transactions.multiTransfer({
			sourceHolderId: "payer",
			amount: 100000,
			destinations: [
				{ holderId: "seller", amount: 95000 },
				{ holderId: "platform", amount: 5000 },
			],
			reference: "multi-1",
		});

		await assertAccountBalance(summa, "payer", 0);
		await assertAccountBalance(summa, "seller", 95000);
		await assertAccountBalance(summa, "platform", 5000);

		await assertDoubleEntryBalance(summa);
	});

	// =========================================================================
	// REFUND
	// =========================================================================

	it("refund reverses a transaction correctly", async () => {
		await summa.accounts.create({ holderId: "refund-user", holderType: "individual" });
		await summa.transactions.credit({
			holderId: "refund-user",
			amount: 30000,
			reference: "fund-refund",
		});

		const txn = await summa.transactions.debit({
			holderId: "refund-user",
			amount: 10000,
			reference: "debit-refund",
		});

		await summa.transactions.refund({
			transactionId: txn.id,
			reason: "Customer request",
		});

		// Balance restored
		await assertAccountBalance(summa, "refund-user", 30000);

		// Double-entry still holds
		await assertDoubleEntryBalance(summa);
	});

	it("partial refund only returns the specified amount", async () => {
		await summa.accounts.create({ holderId: "partial-user", holderType: "individual" });
		await summa.transactions.credit({
			holderId: "partial-user",
			amount: 50000,
			reference: "fund-partial",
		});

		const txn = await summa.transactions.debit({
			holderId: "partial-user",
			amount: 20000,
			reference: "debit-partial",
		});

		await summa.transactions.refund({
			transactionId: txn.id,
			reason: "Partial refund",
			amount: 8000,
		});

		// 50000 - 20000 + 8000 = 38000
		await assertAccountBalance(summa, "partial-user", 38000);
		await assertDoubleEntryBalance(summa);
	});

	// =========================================================================
	// ACCOUNT LIFECYCLE
	// =========================================================================

	it("freeze prevents transactions, unfreeze allows them again", async () => {
		await summa.accounts.create({ holderId: "freeze-user", holderType: "individual" });
		await summa.transactions.credit({
			holderId: "freeze-user",
			amount: 10000,
			reference: "fund-freeze",
		});

		await summa.accounts.freeze({
			holderId: "freeze-user",
			reason: "Suspicious activity",
			frozenBy: "admin",
		});

		await expect(
			summa.transactions.debit({
				holderId: "freeze-user",
				amount: 1000,
				reference: "debit-frozen",
			}),
		).rejects.toThrow(SummaError);

		await summa.accounts.unfreeze({
			holderId: "freeze-user",
			unfrozenBy: "admin",
		});

		// Now it should work
		await summa.transactions.debit({
			holderId: "freeze-user",
			amount: 1000,
			reference: "debit-unfrozen",
		});

		await assertAccountBalance(summa, "freeze-user", 9000);
	});

	// =========================================================================
	// HASH CHAIN
	// =========================================================================

	it("event hash chain is valid after multiple operations", async () => {
		await summa.accounts.create({ holderId: "chain-user", holderType: "individual" });
		await summa.transactions.credit({
			holderId: "chain-user",
			amount: 10000,
			reference: "chain-c1",
		});
		await summa.transactions.debit({
			holderId: "chain-user",
			amount: 3000,
			reference: "chain-d1",
		});

		// Get the account to find its ID for aggregate verification
		const account = await summa.accounts.get("chain-user");

		const result = await summa.events.verifyChain("ACCOUNT", account.id);
		expect(result.valid).toBe(true);
		expect(result.eventCount).toBeGreaterThan(0);
	});
});
