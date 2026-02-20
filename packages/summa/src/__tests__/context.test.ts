import type { SummaAdapter, SummaLogger, SummaPlugin } from "@summa/core";
import { describe, expect, it, vi } from "vitest";
import { buildContext } from "../context/context.js";

// =============================================================================
// HELPERS — minimal mock adapter
// =============================================================================

function createMockAdapter(): SummaAdapter {
	return {
		id: "mock",
		create: vi.fn(),
		findOne: vi.fn(),
		findMany: vi.fn(),
		update: vi.fn(),
		delete: vi.fn(),
		count: vi.fn(),
		transaction: vi.fn(),
		advisoryLock: vi.fn(),
		raw: vi.fn(),
		rawMutate: vi.fn(),
	};
}

function createMockLogger(): SummaLogger {
	return {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	};
}

// =============================================================================
// CONTEXT TESTS
// =============================================================================

describe("buildContext", () => {
	it("returns a valid SummaContext with all required fields", async () => {
		const adapter = createMockAdapter();
		const ctx = await buildContext({ database: adapter });

		expect(ctx).toBeDefined();
		expect(ctx.adapter).toBeDefined();
		expect(ctx.options).toBeDefined();
		expect(ctx.logger).toBeDefined();
		expect(ctx.plugins).toBeDefined();
	});

	it("uses the provided adapter directly when it is an adapter instance", async () => {
		const adapter = createMockAdapter();
		const ctx = await buildContext({ database: adapter });

		expect(ctx.adapter).toBe(adapter);
		expect(ctx.adapter.id).toBe("mock");
	});

	it("calls the factory function when database is a function", async () => {
		const adapter = createMockAdapter();
		const factory = vi.fn(() => adapter);
		const ctx = await buildContext({ database: factory });

		expect(factory).toHaveBeenCalledOnce();
		expect(ctx.adapter).toBe(adapter);
	});

	// =========================================================================
	// DEFAULT LOGGER
	// =========================================================================

	describe("logger", () => {
		it("creates a default logger when not provided", async () => {
			const adapter = createMockAdapter();
			const ctx = await buildContext({ database: adapter });

			expect(ctx.logger).toBeDefined();
			expect(typeof ctx.logger.info).toBe("function");
			expect(typeof ctx.logger.warn).toBe("function");
			expect(typeof ctx.logger.error).toBe("function");
			expect(typeof ctx.logger.debug).toBe("function");
		});

		it("default logger does not throw when called", async () => {
			const adapter = createMockAdapter();
			const ctx = await buildContext({ database: adapter });

			// These should not throw
			expect(() => ctx.logger.info("test")).not.toThrow();
			expect(() => ctx.logger.warn("test")).not.toThrow();
			expect(() => ctx.logger.error("test")).not.toThrow();
			expect(() => ctx.logger.debug("test")).not.toThrow();
		});

		it("default logger does not throw when called with data", async () => {
			const adapter = createMockAdapter();
			const ctx = await buildContext({ database: adapter });

			expect(() => ctx.logger.info("test", { key: "value" })).not.toThrow();
			expect(() => ctx.logger.warn("test", { key: "value" })).not.toThrow();
			expect(() => ctx.logger.error("test", { key: "value" })).not.toThrow();
			expect(() => ctx.logger.debug("test", { key: "value" })).not.toThrow();
		});

		it("uses custom logger when provided", async () => {
			const adapter = createMockAdapter();
			const customLogger = createMockLogger();

			const ctx = await buildContext({
				database: adapter,
				logger: customLogger,
			});

			expect(ctx.logger).toBe(customLogger);
		});

		it("custom logger receives calls", async () => {
			const adapter = createMockAdapter();
			const customLogger = createMockLogger();

			const ctx = await buildContext({
				database: adapter,
				logger: customLogger,
			});

			ctx.logger.info("hello", { foo: "bar" });
			expect(customLogger.info).toHaveBeenCalledWith("hello", { foo: "bar" });
		});
	});

	// =========================================================================
	// SYSTEM ACCOUNTS
	// =========================================================================

	describe("system accounts", () => {
		it("includes default 'world' system account as '@World'", async () => {
			const adapter = createMockAdapter();
			const ctx = await buildContext({ database: adapter });

			expect(ctx.options.systemAccounts).toBeDefined();
			expect(ctx.options.systemAccounts.world).toBe("@World");
		});

		it("parses string system accounts correctly", async () => {
			const adapter = createMockAdapter();
			const ctx = await buildContext({
				database: adapter,
				systemAccounts: {
					fees: "@Fees",
					revenue: "@Revenue",
				},
			});

			expect(ctx.options.systemAccounts.world).toBe("@World");
			expect(ctx.options.systemAccounts.fees).toBe("@Fees");
			expect(ctx.options.systemAccounts.revenue).toBe("@Revenue");
		});

		it("parses SystemAccountDefinition objects correctly", async () => {
			const adapter = createMockAdapter();
			const ctx = await buildContext({
				database: adapter,
				systemAccounts: {
					fees: { identifier: "@Fees", name: "Fee Account" },
					revenue: { identifier: "@Revenue", name: "Revenue Account" },
				},
			});

			expect(ctx.options.systemAccounts.fees).toBe("@Fees");
			expect(ctx.options.systemAccounts.revenue).toBe("@Revenue");
		});

		it("handles mixed string and object system accounts", async () => {
			const adapter = createMockAdapter();
			const ctx = await buildContext({
				database: adapter,
				systemAccounts: {
					fees: "@Fees",
					revenue: { identifier: "@Revenue", name: "Revenue Account" },
				},
			});

			expect(ctx.options.systemAccounts.fees).toBe("@Fees");
			expect(ctx.options.systemAccounts.revenue).toBe("@Revenue");
		});

		it("custom system accounts can override the default world account", async () => {
			const adapter = createMockAdapter();
			const ctx = await buildContext({
				database: adapter,
				systemAccounts: {
					world: "@CustomWorld",
				},
			});

			expect(ctx.options.systemAccounts.world).toBe("@CustomWorld");
		});
	});

	// =========================================================================
	// ADVANCED OPTIONS
	// =========================================================================

	describe("advanced options", () => {
		it("has proper defaults when not provided", async () => {
			const adapter = createMockAdapter();
			const ctx = await buildContext({ database: adapter });

			expect(ctx.options.advanced).toBeDefined();
			expect(ctx.options.advanced.hotAccountThreshold).toBe(1000);
			expect(ctx.options.advanced.idempotencyTTL).toBe(24 * 60 * 60 * 1000);
			expect(ctx.options.advanced.transactionTimeoutMs).toBe(5000);
			expect(ctx.options.advanced.lockTimeoutMs).toBe(3000);
			expect(ctx.options.advanced.maxTransactionAmount).toBe(1_000_000_000_00);
			expect(ctx.options.advanced.enableEventSourcing).toBe(true);
			expect(ctx.options.advanced.enableHashChain).toBe(true);
		});

		it("allows overriding individual advanced options", async () => {
			const adapter = createMockAdapter();
			const ctx = await buildContext({
				database: adapter,
				advanced: {
					hotAccountThreshold: 500,
					transactionTimeoutMs: 10000,
				},
			});

			expect(ctx.options.advanced.hotAccountThreshold).toBe(500);
			expect(ctx.options.advanced.transactionTimeoutMs).toBe(10000);
			// Other defaults remain
			expect(ctx.options.advanced.idempotencyTTL).toBe(24 * 60 * 60 * 1000);
			expect(ctx.options.advanced.lockTimeoutMs).toBe(3000);
			expect(ctx.options.advanced.maxTransactionAmount).toBe(1_000_000_000_00);
			expect(ctx.options.advanced.enableEventSourcing).toBe(true);
			expect(ctx.options.advanced.enableHashChain).toBe(true);
		});

		it("allows disabling event sourcing", async () => {
			const adapter = createMockAdapter();
			const ctx = await buildContext({
				database: adapter,
				advanced: {
					enableEventSourcing: false,
				},
			});

			expect(ctx.options.advanced.enableEventSourcing).toBe(false);
		});

		it("allows disabling hash chain", async () => {
			const adapter = createMockAdapter();
			const ctx = await buildContext({
				database: adapter,
				advanced: {
					enableHashChain: false,
				},
			});

			expect(ctx.options.advanced.enableHashChain).toBe(false);
		});
	});

	// =========================================================================
	// CURRENCY
	// =========================================================================

	describe("currency", () => {
		it("defaults to 'USD' when not specified", async () => {
			const adapter = createMockAdapter();
			const ctx = await buildContext({ database: adapter });

			expect(ctx.options.currency).toBe("USD");
		});

		it("uses provided currency", async () => {
			const adapter = createMockAdapter();
			const ctx = await buildContext({
				database: adapter,
				currency: "EUR",
			});

			expect(ctx.options.currency).toBe("EUR");
		});
	});

	// =========================================================================
	// PLUGINS
	// =========================================================================

	describe("plugins", () => {
		it("defaults to empty array when no plugins provided", async () => {
			const adapter = createMockAdapter();
			const ctx = await buildContext({ database: adapter });

			expect(ctx.plugins).toEqual([]);
		});

		it("passes through provided plugins", async () => {
			const adapter = createMockAdapter();
			const mockPlugin: SummaPlugin = { id: "test-plugin" };
			const anotherPlugin: SummaPlugin = { id: "another-plugin" };

			const ctx = await buildContext({
				database: adapter,
				plugins: [mockPlugin, anotherPlugin],
			});

			expect(ctx.plugins).toHaveLength(2);
			expect(ctx.plugins[0]).toBe(mockPlugin);
			expect(ctx.plugins[1]).toBe(anotherPlugin);
		});
	});
});
