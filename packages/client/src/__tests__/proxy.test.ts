import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSummaProxyClient } from "../proxy.js";

// Mock the fetch client to capture calls without making real HTTP requests
const mockGet = vi.fn().mockResolvedValue({});
const mockPost = vi.fn().mockResolvedValue({});
const mockDel = vi.fn().mockResolvedValue({});

vi.mock("../fetch.js", () => ({
	createFetchClient: vi.fn().mockReturnValue({
		get: (...args: unknown[]) => mockGet(...args),
		post: (...args: unknown[]) => mockPost(...args),
		del: (...args: unknown[]) => mockDel(...args),
	}),
}));

describe("createSummaProxyClient", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns a Proxy object", () => {
		const client = createSummaProxyClient({ baseURL: "http://localhost:3000" });
		expect(client).toBeDefined();
		// A Proxy is transparent, but we can verify it behaves like one
		// by checking that arbitrary property access returns something
		expect(client.anything).toBeDefined();
	});

	it("does not auto-resolve as a promise (then returns undefined)", () => {
		const client = createSummaProxyClient({ baseURL: "http://localhost:3000" });
		// The proxy explicitly returns undefined for 'then' to prevent auto-resolution
		// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- testing internal proxy behavior
		expect((client as Record<string, unknown>).then).toBeUndefined();
	});

	describe("property access chains build correct paths", () => {
		it("single segment: client.accounts.$get() calls GET /accounts", async () => {
			const client = createSummaProxyClient({ baseURL: "http://localhost:3000" });
			await client.accounts.$get();
			expect(mockGet).toHaveBeenCalledWith("/accounts", undefined);
		});

		it("two segments: client.admin.accounts.$get() calls GET /admin/accounts", async () => {
			const client = createSummaProxyClient({ baseURL: "http://localhost:3000" });
			await client.admin.accounts.$get();
			expect(mockGet).toHaveBeenCalledWith("/admin/accounts", undefined);
		});

		it("three segments: client.admin.accounts.stats.$get() calls GET /admin/accounts/stats", async () => {
			const client = createSummaProxyClient({ baseURL: "http://localhost:3000" });
			await client.admin.accounts.stats.$get();
			expect(mockGet).toHaveBeenCalledWith("/admin/accounts/stats", undefined);
		});
	});

	describe("$post sends POST requests", () => {
		it("client.accounts.$post(body) calls POST /accounts", async () => {
			const client = createSummaProxyClient({ baseURL: "http://localhost:3000" });
			const body = { holderId: "user_1", holderType: "user" };
			await client.accounts.$post(body);
			expect(mockPost).toHaveBeenCalledWith("/accounts", body);
		});
	});

	describe("$delete sends DELETE requests", () => {
		it("client.limits.user_1.$delete() calls DELETE /limits/user_1", async () => {
			const client = createSummaProxyClient({ baseURL: "http://localhost:3000" });
			await client.limits.user_1.$delete();
			expect(mockDel).toHaveBeenCalledWith("/limits/user_1", undefined);
		});
	});

	describe("dynamic path segments via function calls", () => {
		it("client.accounts('x').freeze.$post() builds /accounts/x/freeze", async () => {
			const client = createSummaProxyClient({ baseURL: "http://localhost:3000" });
			await client.accounts("x").freeze.$post({ reason: "fraud" });
			expect(mockPost).toHaveBeenCalledWith("/accounts/x/freeze", { reason: "fraud" });
		});

		it("encodes dynamic path segments", async () => {
			const client = createSummaProxyClient({ baseURL: "http://localhost:3000" });
			await client.accounts("user/special").balance.$get();
			expect(mockGet).toHaveBeenCalledWith("/accounts/user%2Fspecial/balance", undefined);
		});
	});

	describe("$get supports query parameters", () => {
		it("passes query object to the get method", async () => {
			const client = createSummaProxyClient({ baseURL: "http://localhost:3000" });
			await client.accounts.$get({ page: "1", perPage: "10" });
			expect(mockGet).toHaveBeenCalledWith("/accounts", { page: "1", perPage: "10" });
		});
	});
});
