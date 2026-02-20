import { describe, expect, it, vi } from "vitest";
import { createSummaClient } from "../client.js";

// Mock the fetch client so we don't make real HTTP requests
vi.mock("../fetch.js", () => ({
	createFetchClient: vi.fn().mockReturnValue({
		get: vi.fn().mockResolvedValue({}),
		post: vi.fn().mockResolvedValue({}),
		del: vi.fn().mockResolvedValue({}),
	}),
}));

describe("createSummaClient", () => {
	it("returns an object with all expected top-level namespaces", () => {
		const client = createSummaClient({ baseURL: "http://localhost:3000/api/ledger" });

		expect(client).toBeDefined();
		expect(client).toHaveProperty("accounts");
		expect(client).toHaveProperty("transactions");
		expect(client).toHaveProperty("holds");
		expect(client).toHaveProperty("limits");
		expect(client).toHaveProperty("events");
	});

	describe("accounts namespace", () => {
		it("has all expected methods as functions", () => {
			const client = createSummaClient({ baseURL: "http://localhost:3000" });
			const { accounts } = client;

			expect(typeof accounts.create).toBe("function");
			expect(typeof accounts.get).toBe("function");
			expect(typeof accounts.getBalance).toBe("function");
			expect(typeof accounts.freeze).toBe("function");
			expect(typeof accounts.unfreeze).toBe("function");
			expect(typeof accounts.close).toBe("function");
			expect(typeof accounts.list).toBe("function");
		});
	});

	describe("transactions namespace", () => {
		it("has all expected methods as functions", () => {
			const client = createSummaClient({ baseURL: "http://localhost:3000" });
			const { transactions } = client;

			expect(typeof transactions.credit).toBe("function");
			expect(typeof transactions.debit).toBe("function");
			expect(typeof transactions.transfer).toBe("function");
			expect(typeof transactions.multiTransfer).toBe("function");
			expect(typeof transactions.refund).toBe("function");
			expect(typeof transactions.get).toBe("function");
			expect(typeof transactions.list).toBe("function");
		});
	});

	describe("holds namespace", () => {
		it("has all expected methods as functions", () => {
			const client = createSummaClient({ baseURL: "http://localhost:3000" });
			const { holds } = client;

			expect(typeof holds.create).toBe("function");
			expect(typeof holds.commit).toBe("function");
			expect(typeof holds.void).toBe("function");
			expect(typeof holds.get).toBe("function");
			expect(typeof holds.listActive).toBe("function");
			expect(typeof holds.listAll).toBe("function");
		});
	});

	describe("events namespace", () => {
		it("has all expected methods as functions", () => {
			const client = createSummaClient({ baseURL: "http://localhost:3000" });
			const { events } = client;

			expect(typeof events.getForAggregate).toBe("function");
			expect(typeof events.getByCorrelation).toBe("function");
			expect(typeof events.verifyChain).toBe("function");
		});
	});

	describe("limits namespace", () => {
		it("has all expected methods as functions", () => {
			const client = createSummaClient({ baseURL: "http://localhost:3000" });
			const { limits } = client;

			expect(typeof limits.set).toBe("function");
			expect(typeof limits.get).toBe("function");
			expect(typeof limits.remove).toBe("function");
			expect(typeof limits.getUsage).toBe("function");
		});
	});

	describe("method invocations call the fetch client", () => {
		it("accounts.create calls http.post with /accounts", async () => {
			const { createFetchClient } = await import("../fetch.js");
			const mockPost = vi.fn().mockResolvedValue({ id: "acc_123" });
			(createFetchClient as ReturnType<typeof vi.fn>).mockReturnValue({
				get: vi.fn(),
				post: mockPost,
				del: vi.fn(),
			});

			const client = createSummaClient({ baseURL: "http://localhost:3000" });
			await client.accounts.create({
				holderId: "user_1",
				holderType: "individual",
			});

			expect(mockPost).toHaveBeenCalledWith("/accounts", {
				holderId: "user_1",
				holderType: "individual",
			});
		});

		it("accounts.get calls http.get with encoded holderId", async () => {
			const { createFetchClient } = await import("../fetch.js");
			const mockGet = vi.fn().mockResolvedValue({ id: "acc_123" });
			(createFetchClient as ReturnType<typeof vi.fn>).mockReturnValue({
				get: mockGet,
				post: vi.fn(),
				del: vi.fn(),
			});

			const client = createSummaClient({ baseURL: "http://localhost:3000" });
			await client.accounts.get("user_1");

			expect(mockGet).toHaveBeenCalledWith("/accounts/user_1");
		});

		it("transactions.get calls http.get with encoded id", async () => {
			const { createFetchClient } = await import("../fetch.js");
			const mockGet = vi.fn().mockResolvedValue({ id: "txn_123" });
			(createFetchClient as ReturnType<typeof vi.fn>).mockReturnValue({
				get: mockGet,
				post: vi.fn(),
				del: vi.fn(),
			});

			const client = createSummaClient({ baseURL: "http://localhost:3000" });
			await client.transactions.get("txn_123");

			expect(mockGet).toHaveBeenCalledWith("/transactions/txn_123");
		});
	});
});
