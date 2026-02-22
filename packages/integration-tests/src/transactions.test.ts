import { SummaError } from "@summa-ledger/core";
import type { Summa } from "@summa-ledger/summa";
import { assertAccountBalance, assertDoubleEntryBalance } from "@summa-ledger/test-utils";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanupTables, closePool, createIntegrationInstance, createTestSchema } from "./setup.js";

/**
 * Transaction listing, filtering, and edge case tests.
 *
 * Requires PostgreSQL running via docker-compose.
 */
describe("Transaction Tests", () => {
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
	// TRANSACTION LISTING
	// =========================================================================

	it("lists transactions for an account with pagination", async () => {
		await summa.accounts.create({ holderId: "list-txn", holderType: "individual" });
		await summa.transactions.credit({ holderId: "list-txn", amount: 100000, reference: "lt-fund" });

		// Create 5 debits
		for (let i = 0; i < 5; i++) {
			await summa.transactions.debit({
				holderId: "list-txn",
				amount: 1000,
				reference: `lt-d${i}`,
			});
		}

		// Page 1
		const page1 = await summa.transactions.list({
			holderId: "list-txn",
			page: 1,
			perPage: 3,
		});
		expect(page1.transactions.length).toBe(3);
		expect(page1.hasMore).toBe(true);

		// Page 2
		const page2 = await summa.transactions.list({
			holderId: "list-txn",
			page: 2,
			perPage: 3,
		});
		expect(page2.transactions.length).toBeGreaterThanOrEqual(2);
	});

	// =========================================================================
	// GET TRANSACTION
	// =========================================================================

	it("get transaction by ID returns the correct transaction", async () => {
		await summa.accounts.create({ holderId: "get-txn", holderType: "individual" });
		const txn = await summa.transactions.credit({
			holderId: "get-txn",
			amount: 15000,
			reference: "gt-c1",
			description: "Test credit",
		});

		const fetched = await summa.transactions.get(txn.id);
		expect(fetched.id).toBe(txn.id);
		expect(fetched.amount).toBe(15000);
		expect(fetched.reference).toBe("gt-c1");
	});

	it("get non-existent transaction throws NOT_FOUND", async () => {
		try {
			await summa.transactions.get("00000000-0000-0000-0000-000000000000");
			expect.unreachable("Should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(SummaError);
			expect((err as SummaError).code).toBe("NOT_FOUND");
		}
	});

	// =========================================================================
	// DUPLICATE REFERENCE
	// =========================================================================

	it("duplicate reference is rejected", async () => {
		await summa.accounts.create({ holderId: "dup-ref", holderType: "individual" });
		await summa.transactions.credit({
			holderId: "dup-ref",
			amount: 10000,
			reference: "unique-ref",
		});

		await expect(
			summa.transactions.credit({
				holderId: "dup-ref",
				amount: 5000,
				reference: "unique-ref",
			}),
		).rejects.toThrow();
	});

	// =========================================================================
	// TRANSFER EDGE CASES
	// =========================================================================

	it("transfer to self is either rejected or is a no-op", async () => {
		await summa.accounts.create({ holderId: "self-xfer", holderType: "individual" });
		await summa.transactions.credit({
			holderId: "self-xfer",
			amount: 20000,
			reference: "sf-fund",
		});

		// Self-transfer should either error or leave balance unchanged
		try {
			await summa.transactions.transfer({
				sourceHolderId: "self-xfer",
				destinationHolderId: "self-xfer",
				amount: 5000,
				reference: "sf-t1",
			});

			// If it succeeds, balance should remain the same
			await assertAccountBalance(summa, "self-xfer", 20000);
		} catch {
			// Expected: self-transfer rejected
		}

		await assertDoubleEntryBalance(summa);
	});

	it("transfer of zero amount is rejected", async () => {
		await summa.accounts.create({ holderId: "zero-src", holderType: "individual" });
		await summa.accounts.create({ holderId: "zero-dst", holderType: "individual" });

		await expect(
			summa.transactions.transfer({
				sourceHolderId: "zero-src",
				destinationHolderId: "zero-dst",
				amount: 0,
				reference: "zero-t1",
			}),
		).rejects.toThrow();
	});

	it("transfer of negative amount is rejected", async () => {
		await summa.accounts.create({ holderId: "neg-src", holderType: "individual" });
		await summa.accounts.create({ holderId: "neg-dst", holderType: "individual" });

		await expect(
			summa.transactions.transfer({
				sourceHolderId: "neg-src",
				destinationHolderId: "neg-dst",
				amount: -1000,
				reference: "neg-t1",
			}),
		).rejects.toThrow();
	});

	// =========================================================================
	// MULTI-TRANSFER
	// =========================================================================

	it("multiTransfer rejects if destination amounts don't sum to total", async () => {
		await summa.accounts.create({ holderId: "mt-src", holderType: "individual" });
		await summa.accounts.create({ holderId: "mt-d1", holderType: "individual" });
		await summa.accounts.create({ holderId: "mt-d2", holderType: "individual" });

		await summa.transactions.credit({ holderId: "mt-src", amount: 50000, reference: "mt-fund" });

		await expect(
			summa.transactions.multiTransfer({
				sourceHolderId: "mt-src",
				amount: 50000,
				destinations: [
					{ holderId: "mt-d1", amount: 30000 },
					{ holderId: "mt-d2", amount: 10000 }, // 30000 + 10000 = 40000 != 50000
				],
				reference: "mt-bad",
			}),
		).rejects.toThrow();
	});

	it("multiTransfer with 3 destinations distributes correctly", async () => {
		await summa.accounts.create({ holderId: "mt3-src", holderType: "individual" });
		await summa.accounts.create({ holderId: "mt3-d1", holderType: "individual" });
		await summa.accounts.create({ holderId: "mt3-d2", holderType: "individual" });
		await summa.accounts.create({ holderId: "mt3-d3", holderType: "individual" });

		await summa.transactions.credit({ holderId: "mt3-src", amount: 90000, reference: "mt3-fund" });

		await summa.transactions.multiTransfer({
			sourceHolderId: "mt3-src",
			amount: 90000,
			destinations: [
				{ holderId: "mt3-d1", amount: 50000 },
				{ holderId: "mt3-d2", amount: 30000 },
				{ holderId: "mt3-d3", amount: 10000 },
			],
			reference: "mt3-xfer",
		});

		await assertAccountBalance(summa, "mt3-src", 0);
		await assertAccountBalance(summa, "mt3-d1", 50000);
		await assertAccountBalance(summa, "mt3-d2", 30000);
		await assertAccountBalance(summa, "mt3-d3", 10000);

		await assertDoubleEntryBalance(summa);
	});

	// =========================================================================
	// REFUND EDGE CASES
	// =========================================================================

	it("refund of a credit reverses the credit", async () => {
		await summa.accounts.create({ holderId: "ref-credit", holderType: "individual" });
		const txn = await summa.transactions.credit({
			holderId: "ref-credit",
			amount: 20000,
			reference: "rc-c1",
		});

		await summa.transactions.refund({
			transactionId: txn.id,
			reason: "Reversal",
		});

		await assertAccountBalance(summa, "ref-credit", 0);
		await assertDoubleEntryBalance(summa);
	});

	it("refund more than original amount is rejected", async () => {
		await summa.accounts.create({ holderId: "overref", holderType: "individual" });
		await summa.transactions.credit({ holderId: "overref", amount: 50000, reference: "or-fund" });

		const txn = await summa.transactions.debit({
			holderId: "overref",
			amount: 10000,
			reference: "or-d1",
		});

		await expect(
			summa.transactions.refund({
				transactionId: txn.id,
				reason: "Too much",
				amount: 20000,
			}),
		).rejects.toThrow();
	});

	it("multiple partial refunds reduce remaining refundable amount", async () => {
		await summa.accounts.create({ holderId: "multi-ref", holderType: "individual" });
		await summa.transactions.credit({
			holderId: "multi-ref",
			amount: 50000,
			reference: "mr-fund",
		});

		const txn = await summa.transactions.debit({
			holderId: "multi-ref",
			amount: 20000,
			reference: "mr-d1",
		});

		// First partial refund: 8000
		await summa.transactions.refund({
			transactionId: txn.id,
			reason: "Partial 1",
			amount: 8000,
		});

		// Second partial refund: 7000 (total: 15000 <= 20000, ok)
		await summa.transactions.refund({
			transactionId: txn.id,
			reason: "Partial 2",
			amount: 7000,
		});

		// Balance: 50000 - 20000 + 8000 + 7000 = 45000
		await assertAccountBalance(summa, "multi-ref", 45000);

		// Third partial refund: 10000 would exceed original (15000 + 10000 > 20000)
		await expect(
			summa.transactions.refund({
				transactionId: txn.id,
				reason: "Too much total",
				amount: 10000,
			}),
		).rejects.toThrow();

		await assertDoubleEntryBalance(summa);
	});

	// =========================================================================
	// TRANSACTION WITH METADATA
	// =========================================================================

	it("transaction metadata is preserved", async () => {
		await summa.accounts.create({ holderId: "meta-txn", holderType: "individual" });
		const txn = await summa.transactions.credit({
			holderId: "meta-txn",
			amount: 5000,
			reference: "mt-c1",
			metadata: { orderId: "ORD-123", source: "api" },
		});

		const fetched = await summa.transactions.get(txn.id);
		expect(fetched.metadata).toEqual({ orderId: "ORD-123", source: "api" });
	});

	// =========================================================================
	// EVENT CORRELATION
	// =========================================================================

	it("events for a transaction share the same correlation ID", async () => {
		await summa.accounts.create({ holderId: "corr-user", holderType: "individual" });
		const txn = await summa.transactions.credit({
			holderId: "corr-user",
			amount: 10000,
			reference: "corr-c1",
		});

		const events = await summa.events.getByCorrelation(txn.correlationId);
		expect(events.length).toBeGreaterThanOrEqual(1);

		// All events should share the same correlation ID
		for (const evt of events) {
			expect(evt.correlationId).toBe(txn.correlationId);
		}
	});

	// =========================================================================
	// HASH CHAIN INTEGRITY
	// =========================================================================

	it("hash chain remains valid after many operations", async () => {
		await summa.accounts.create({ holderId: "chain-multi", holderType: "individual" });

		// Perform many operations
		await summa.transactions.credit({
			holderId: "chain-multi",
			amount: 100000,
			reference: "cm-fund",
		});

		for (let i = 0; i < 10; i++) {
			await summa.transactions.debit({
				holderId: "chain-multi",
				amount: 1000,
				reference: `cm-d${i}`,
			});
		}

		const account = await summa.accounts.get("chain-multi");
		const result = await summa.events.verifyChain("ACCOUNT", account.id);
		expect(result.valid).toBe(true);
		expect(result.eventCount).toBeGreaterThan(0);
	});
});
