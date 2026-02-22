import { describe, expect, it, vi } from "vitest";
import { hotAccounts } from "../plugins/hot-accounts.js";
import { outbox } from "../plugins/outbox.js";
import { reconciliation } from "../plugins/reconciliation.js";
import { scheduledTransactions } from "../plugins/scheduled-transactions.js";
import { snapshots } from "../plugins/snapshots.js";
import { velocityLimits } from "../plugins/velocity-limits.js";

// =============================================================================
// PLUGIN STRUCTURE TESTS
// =============================================================================

describe("plugins", () => {
	// =========================================================================
	// VELOCITY LIMITS
	// =========================================================================

	describe("velocityLimits", () => {
		it("returns a valid SummaPlugin with id property", () => {
			const plugin = velocityLimits();
			expect(plugin).toBeDefined();
			expect(plugin.id).toBeDefined();
			expect(typeof plugin.id).toBe("string");
		});

		it("has id 'velocity-limits'", () => {
			const plugin = velocityLimits();
			expect(plugin.id).toBe("velocity-limits");
		});

		it("has a beforeTransaction hook by default (autoEnforce is true)", () => {
			const plugin = velocityLimits();
			expect(plugin.hooks).toBeDefined();
			expect(plugin.hooks?.beforeTransaction).toBeDefined();
			expect(typeof plugin.hooks?.beforeTransaction).toBe("function");
		});

		it("has a worker with id 'velocity-log-cleanup'", () => {
			const plugin = velocityLimits();
			expect(plugin.workers).toBeDefined();
			expect(plugin.workers).toHaveLength(1);
			expect(plugin.workers?.[0].id).toBe("velocity-log-cleanup");
			expect(plugin.workers?.[0].interval).toBe("1d");
			expect(plugin.workers?.[0].leaseRequired).toBe(true);
		});

		it("has no hooks when autoEnforce is false", () => {
			const plugin = velocityLimits({ autoEnforce: false });
			expect(plugin.hooks).toBeUndefined();
		});

		it("still has workers when autoEnforce is false", () => {
			const plugin = velocityLimits({ autoEnforce: false });
			expect(plugin.workers).toBeDefined();
			expect(plugin.workers).toHaveLength(1);
			expect(plugin.workers?.[0].id).toBe("velocity-log-cleanup");
		});

		it("applies cleanupRetentionDays option", () => {
			const plugin = velocityLimits({ cleanupRetentionDays: 30 });
			// The worker still exists with same structure
			expect(plugin.workers).toBeDefined();
			expect(plugin.workers).toHaveLength(1);
			expect(plugin.workers?.[0].id).toBe("velocity-log-cleanup");
			// The handler is a function that captures the retentionDays option
			expect(typeof plugin.workers?.[0].handler).toBe("function");
		});

		it("applies autoEnforce option explicitly set to true", () => {
			const plugin = velocityLimits({ autoEnforce: true });
			expect(plugin.hooks).toBeDefined();
			expect(plugin.hooks?.beforeTransaction).toBeDefined();
		});
	});

	// =========================================================================
	// RECONCILIATION
	// =========================================================================

	describe("reconciliation", () => {
		it("returns a valid SummaPlugin with id property", () => {
			const plugin = reconciliation();
			expect(plugin).toBeDefined();
			expect(plugin.id).toBeDefined();
			expect(typeof plugin.id).toBe("string");
		});

		it("has id 'reconciliation'", () => {
			const plugin = reconciliation();
			expect(plugin.id).toBe("reconciliation");
		});

		it("has an init function", () => {
			const plugin = reconciliation();
			expect(plugin.init).toBeDefined();
			expect(typeof plugin.init).toBe("function");
		});

		it("has no hooks", () => {
			const plugin = reconciliation();
			expect(plugin.hooks).toBeUndefined();
		});

		it("has workers for daily-reconciliation, block-checkpoint, and fast-reconciliation", () => {
			const plugin = reconciliation();
			expect(plugin.workers).toBeDefined();
			expect(plugin.workers).toHaveLength(3);
			expect(plugin.workers?.[0].id).toBe("daily-reconciliation");
			expect(plugin.workers?.[0].interval).toBe("1d");
			expect(plugin.workers?.[0].leaseRequired).toBe(true);
			expect(plugin.workers?.[1].id).toBe("block-checkpoint");
			expect(plugin.workers?.[1].interval).toBe("1h");
			expect(plugin.workers?.[1].leaseRequired).toBe(true);
			expect(plugin.workers?.[2].id).toBe("fast-reconciliation");
			expect(plugin.workers?.[2].interval).toBe("1h");
			expect(plugin.workers?.[2].leaseRequired).toBe(true);
		});

		it("workers have handler functions", () => {
			const plugin = reconciliation();
			expect(typeof plugin.workers?.[0].handler).toBe("function");
			expect(typeof plugin.workers?.[1].handler).toBe("function");
		});

		it("workers have descriptions", () => {
			const plugin = reconciliation();
			expect(plugin.workers?.[0].description).toBeDefined();
			expect(typeof plugin.workers?.[0].description).toBe("string");
			expect(plugin.workers?.[0].description?.length).toBeGreaterThan(0);
		});
	});

	// =========================================================================
	// SNAPSHOTS
	// =========================================================================

	describe("snapshots", () => {
		it("returns a valid SummaPlugin with id property", () => {
			const plugin = snapshots();
			expect(plugin).toBeDefined();
			expect(plugin.id).toBeDefined();
			expect(typeof plugin.id).toBe("string");
		});

		it("has id 'snapshots'", () => {
			const plugin = snapshots();
			expect(plugin.id).toBe("snapshots");
		});

		it("has no hooks", () => {
			const plugin = snapshots();
			expect(plugin.hooks).toBeUndefined();
		});

		it("has no init function", () => {
			const plugin = snapshots();
			expect(plugin.init).toBeUndefined();
		});

		it("has a worker with id 'daily-snapshots'", () => {
			const plugin = snapshots();
			expect(plugin.workers).toBeDefined();
			expect(plugin.workers).toHaveLength(1);
			expect(plugin.workers?.[0].id).toBe("daily-snapshots");
			expect(plugin.workers?.[0].interval).toBe("1d");
			expect(plugin.workers?.[0].leaseRequired).toBe(true);
		});

		it("worker has a handler function", () => {
			const plugin = snapshots();
			expect(typeof plugin.workers?.[0].handler).toBe("function");
		});
	});

	// =========================================================================
	// OUTBOX
	// =========================================================================

	describe("outbox", () => {
		const mockPublisher = vi.fn().mockResolvedValue(undefined);

		it("returns a valid SummaPlugin with id property", () => {
			const plugin = outbox({ publisher: mockPublisher });
			expect(plugin).toBeDefined();
			expect(plugin.id).toBeDefined();
			expect(typeof plugin.id).toBe("string");
		});

		it("has id 'outbox'", () => {
			const plugin = outbox({ publisher: mockPublisher });
			expect(plugin.id).toBe("outbox");
		});

		it("has no hooks", () => {
			const plugin = outbox({ publisher: mockPublisher });
			expect(plugin.hooks).toBeUndefined();
		});

		it("has no init function", () => {
			const plugin = outbox({ publisher: mockPublisher });
			expect(plugin.init).toBeUndefined();
		});

		it("has two workers: outbox-processor and outbox-cleanup", () => {
			const plugin = outbox({ publisher: mockPublisher });
			expect(plugin.workers).toBeDefined();
			expect(plugin.workers).toHaveLength(2);

			const workerIds = plugin.workers?.map((w) => w.id);
			expect(workerIds).toContain("outbox-processor");
			expect(workerIds).toContain("outbox-cleanup");
		});

		it("outbox-processor worker has interval '5s' and leaseRequired false", () => {
			const plugin = outbox({ publisher: mockPublisher });
			const processor = plugin.workers?.find((w) => w.id === "outbox-processor");
			expect(processor?.interval).toBe("5s");
			expect(processor?.leaseRequired).toBe(false);
		});

		it("outbox-cleanup worker has interval '6h' and leaseRequired true", () => {
			const plugin = outbox({ publisher: mockPublisher });
			const cleanup = plugin.workers?.find((w) => w.id === "outbox-cleanup");
			expect(cleanup?.interval).toBe("6h");
			expect(cleanup?.leaseRequired).toBe(true);
		});

		it("applies custom options", () => {
			const plugin = outbox({
				publisher: mockPublisher,
				batchSize: 50,
				maxRetries: 5,
				retentionHours: 72,
			});
			// The plugin is still created correctly with the same structure
			expect(plugin.id).toBe("outbox");
			expect(plugin.workers).toHaveLength(2);
		});
	});

	// =========================================================================
	// HOT ACCOUNTS
	// =========================================================================

	describe("hotAccounts", () => {
		it("returns a valid SummaPlugin with id property", () => {
			const plugin = hotAccounts();
			expect(plugin).toBeDefined();
			expect(plugin.id).toBeDefined();
			expect(typeof plugin.id).toBe("string");
		});

		it("has id 'hot-accounts'", () => {
			const plugin = hotAccounts();
			expect(plugin.id).toBe("hot-accounts");
		});

		it("has no hooks", () => {
			const plugin = hotAccounts();
			expect(plugin.hooks).toBeUndefined();
		});

		it("has no init function", () => {
			const plugin = hotAccounts();
			expect(plugin.init).toBeUndefined();
		});

		it("has two workers: hot-account-processor and hot-account-cleanup", () => {
			const plugin = hotAccounts();
			expect(plugin.workers).toBeDefined();
			expect(plugin.workers).toHaveLength(2);

			const workerIds = plugin.workers?.map((w) => w.id);
			expect(workerIds).toContain("hot-account-processor");
			expect(workerIds).toContain("hot-account-cleanup");
		});

		it("hot-account-processor worker has interval '30s' and leaseRequired true", () => {
			const plugin = hotAccounts();
			const processor = plugin.workers?.find((w) => w.id === "hot-account-processor");
			expect(processor?.interval).toBe("30s");
			expect(processor?.leaseRequired).toBe(true);
		});

		it("hot-account-cleanup worker has interval '6h' and leaseRequired true", () => {
			const plugin = hotAccounts();
			const cleanup = plugin.workers?.find((w) => w.id === "hot-account-cleanup");
			expect(cleanup?.interval).toBe("6h");
			expect(cleanup?.leaseRequired).toBe(true);
		});

		it("accepts custom options", () => {
			const plugin = hotAccounts({ batchSize: 500, retentionHours: 48 });
			expect(plugin.id).toBe("hot-accounts");
			expect(plugin.workers).toHaveLength(2);
		});

		it("uses defaults when no options provided", () => {
			const plugin = hotAccounts();
			expect(plugin.workers).toHaveLength(2);
			// Workers should still have their handler functions
			for (const worker of plugin.workers!) {
				expect(typeof worker.handler).toBe("function");
			}
		});
	});

	// =========================================================================
	// SCHEDULED TRANSACTIONS
	// =========================================================================

	describe("scheduledTransactions", () => {
		it("returns a valid SummaPlugin with id property", () => {
			const plugin = scheduledTransactions();
			expect(plugin).toBeDefined();
			expect(plugin.id).toBeDefined();
			expect(typeof plugin.id).toBe("string");
		});

		it("has id 'scheduled-transactions'", () => {
			const plugin = scheduledTransactions();
			expect(plugin.id).toBe("scheduled-transactions");
		});

		it("has no hooks", () => {
			const plugin = scheduledTransactions();
			expect(plugin.hooks).toBeUndefined();
		});

		it("has no init function", () => {
			const plugin = scheduledTransactions();
			expect(plugin.init).toBeUndefined();
		});

		it("has a worker with id 'scheduled-processor'", () => {
			const plugin = scheduledTransactions();
			expect(plugin.workers).toBeDefined();
			expect(plugin.workers).toHaveLength(1);
			expect(plugin.workers?.[0].id).toBe("scheduled-processor");
			expect(plugin.workers?.[0].interval).toBe("1m");
			expect(plugin.workers?.[0].leaseRequired).toBe(true);
		});

		it("worker has a handler function", () => {
			const plugin = scheduledTransactions();
			expect(typeof plugin.workers?.[0].handler).toBe("function");
		});

		it("accepts custom options", () => {
			const plugin = scheduledTransactions({
				maxRetries: 5,
				batchSize: 50,
				maxBatchesPerRun: 10,
			});
			expect(plugin.id).toBe("scheduled-transactions");
			expect(plugin.workers).toHaveLength(1);
			expect(plugin.workers?.[0].id).toBe("scheduled-processor");
		});

		it("uses defaults when no options provided", () => {
			const plugin = scheduledTransactions();
			expect(plugin.workers).toHaveLength(1);
			expect(typeof plugin.workers?.[0].handler).toBe("function");
		});
	});

	// =========================================================================
	// CROSS-PLUGIN STRUCTURAL CHECKS
	// =========================================================================

	describe("all plugins share a consistent structure", () => {
		const allPlugins = [
			{ name: "velocityLimits", factory: () => velocityLimits() },
			{ name: "reconciliation", factory: () => reconciliation() },
			{ name: "snapshots", factory: () => snapshots() },
			{
				name: "outbox",
				factory: () => outbox({ publisher: vi.fn().mockResolvedValue(undefined) }),
			},
			{ name: "hotAccounts", factory: () => hotAccounts() },
			{ name: "scheduledTransactions", factory: () => scheduledTransactions() },
		];

		it.each(allPlugins)("$name has a non-empty string id", ({ factory }) => {
			const plugin = factory();
			expect(typeof plugin.id).toBe("string");
			expect(plugin.id.length).toBeGreaterThan(0);
		});

		it.each(allPlugins)("$name has workers array (if defined) with valid entries", ({
			factory,
		}) => {
			const plugin = factory();
			if (plugin.workers) {
				expect(Array.isArray(plugin.workers)).toBe(true);
				for (const worker of plugin.workers) {
					expect(typeof worker.id).toBe("string");
					expect(worker.id.length).toBeGreaterThan(0);
					expect(typeof worker.handler).toBe("function");
					expect(typeof worker.interval).toBe("string");
					expect(worker.interval.length).toBeGreaterThan(0);
				}
			}
		});
	});
});
