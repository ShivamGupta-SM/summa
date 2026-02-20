import type { SummaContext, SummaPlugin } from "@summa/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseInterval, SummaWorkerRunner } from "../infrastructure/worker-runner.js";

// ---------------------------------------------------------------------------
// parseInterval
// ---------------------------------------------------------------------------

describe("parseInterval", () => {
	it('parses "5s" to 5000 ms', () => {
		expect(parseInterval("5s")).toBe(5_000);
	});

	it('parses "1m" to 60000 ms', () => {
		expect(parseInterval("1m")).toBe(60_000);
	});

	it('parses "1h" to 3600000 ms', () => {
		expect(parseInterval("1h")).toBe(3_600_000);
	});

	it('parses "1d" to 86400000 ms', () => {
		expect(parseInterval("1d")).toBe(86_400_000);
	});

	it('parses "30m" to 1800000 ms', () => {
		expect(parseInterval("30m")).toBe(1_800_000);
	});

	it('parses "0.5h" to 1800000 ms', () => {
		expect(parseInterval("0.5h")).toBe(1_800_000);
	});

	it("throws on invalid input (no unit)", () => {
		expect(() => parseInterval("100")).toThrow(/Invalid interval/);
	});

	it("throws on invalid input (unknown unit)", () => {
		expect(() => parseInterval("5x")).toThrow(/Invalid interval/);
	});

	it("throws on invalid input (empty string)", () => {
		expect(() => parseInterval("")).toThrow(/Invalid interval/);
	});

	it("throws on invalid input (negative value)", () => {
		expect(() => parseInterval("-5s")).toThrow(/Invalid interval/);
	});

	it("throws on invalid input (text)", () => {
		expect(() => parseInterval("abc")).toThrow(/Invalid interval/);
	});
});

// ---------------------------------------------------------------------------
// SummaWorkerRunner
// ---------------------------------------------------------------------------

describe("SummaWorkerRunner", () => {
	// Helper to build a minimal mock SummaContext
	function createMockContext(plugins: SummaPlugin[] = []): SummaContext {
		return {
			adapter: {
				raw: vi.fn().mockRejectedValue(new Error("Not supported in memory adapter")),
				rawMutate: vi.fn().mockRejectedValue(new Error("Not supported in memory adapter")),
			} as any,
			options: {
				currency: "USD",
				systemAccounts: {},
				advanced: {
					hotAccountThreshold: 100,
					idempotencyTTL: 86400,
					transactionTimeoutMs: 30000,
					lockTimeoutMs: 5000,
					maxTransactionAmount: 1_000_000_00,
					enableEventSourcing: true,
					enableHashChain: true,
				},
			},
			logger: {
				info: vi.fn(),
				error: vi.fn(),
				warn: vi.fn(),
				debug: vi.fn(),
			},
			plugins,
		};
	}

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("collects workers from plugins", () => {
		const handler = vi.fn();
		const plugin: SummaPlugin = {
			id: "test-plugin",
			workers: [{ id: "test-worker", interval: "5s", handler }],
		};

		const ctx = createMockContext([plugin]);
		const runner = new SummaWorkerRunner(ctx);
		runner.start();

		// The runner logs the worker count
		expect(ctx.logger.info).toHaveBeenCalledWith(
			"Starting worker runner",
			expect.objectContaining({
				workerCount: 1,
				workers: ["test-worker"],
			}),
		);

		// Clean up timers
		runner.stop();
	});

	it("logs a message when no workers are registered", () => {
		const ctx = createMockContext([]);
		const runner = new SummaWorkerRunner(ctx);
		runner.start();

		expect(ctx.logger.info).toHaveBeenCalledWith("No plugin workers registered");
	});

	it("throws if started twice", () => {
		const ctx = createMockContext([]);
		const runner = new SummaWorkerRunner(ctx);
		runner.start();

		expect(() => runner.start()).toThrow("SummaWorkerRunner is already started");
	});

	it("can start and stop without errors", async () => {
		const handler = vi.fn();
		const plugin: SummaPlugin = {
			id: "test-plugin",
			workers: [{ id: "test-worker", interval: "1m", handler }],
		};

		const ctx = createMockContext([plugin]);
		const runner = new SummaWorkerRunner(ctx);

		runner.start();
		await runner.stop();

		expect(ctx.logger.info).toHaveBeenCalledWith(
			"Stopping worker runner",
			expect.objectContaining({ leaseHolder: expect.any(String) }),
		);
	});

	it("stop is idempotent (can be called multiple times)", async () => {
		const ctx = createMockContext([]);
		const runner = new SummaWorkerRunner(ctx);
		runner.start();

		await runner.stop();
		await runner.stop(); // Second call should be a no-op
	});

	it("collects workers from multiple plugins", () => {
		const plugin1: SummaPlugin = {
			id: "plugin-1",
			workers: [{ id: "worker-a", interval: "5s", handler: vi.fn() }],
		};
		const plugin2: SummaPlugin = {
			id: "plugin-2",
			workers: [
				{ id: "worker-b", interval: "10s", handler: vi.fn() },
				{ id: "worker-c", interval: "1m", handler: vi.fn() },
			],
		};

		const ctx = createMockContext([plugin1, plugin2]);
		const runner = new SummaWorkerRunner(ctx);
		runner.start();

		expect(ctx.logger.info).toHaveBeenCalledWith(
			"Starting worker runner",
			expect.objectContaining({
				workerCount: 3,
				workers: ["worker-a", "worker-b", "worker-c"],
			}),
		);

		runner.stop();
	});

	it("skips plugins that have no workers property", () => {
		const pluginWithoutWorkers: SummaPlugin = {
			id: "no-workers-plugin",
		};
		const pluginWithWorkers: SummaPlugin = {
			id: "has-workers",
			workers: [{ id: "w1", interval: "5s", handler: vi.fn() }],
		};

		const ctx = createMockContext([pluginWithoutWorkers, pluginWithWorkers]);
		const runner = new SummaWorkerRunner(ctx);
		runner.start();

		expect(ctx.logger.info).toHaveBeenCalledWith(
			"Starting worker runner",
			expect.objectContaining({
				workerCount: 1,
				workers: ["w1"],
			}),
		);

		runner.stop();
	});
});
