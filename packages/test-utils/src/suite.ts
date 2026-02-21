// =============================================================================
// TEST SUITE RUNNER — Structured test helpers with timing and stats
// =============================================================================
// Provides a structured way to group and run Summa tests with automatic
// setup/teardown, timing statistics, and assertion helpers.

import type { SummaPlugin } from "@summa/core";
import type { SummaOptions } from "summa";
import { getTestInstance, type TestInstance } from "./get-test-instance.js";

// =============================================================================
// TYPES
// =============================================================================

export interface TestSuiteOptions {
	/** Database adapter (use memoryAdapter for unit tests) */
	adapter: SummaOptions["database"];
	/** Currency. Default: "USD" */
	currency?: string;
	/** Plugins to enable */
	plugins?: SummaPlugin[];
	/** System accounts override */
	systemAccounts?: SummaOptions["systemAccounts"];
}

export interface TestSuiteStats {
	totalTests: number;
	passedTests: number;
	failedTests: number;
	skippedTests: number;
	totalDurationMs: number;
	tests: TestResult[];
}

export interface TestResult {
	name: string;
	group: string;
	status: "passed" | "failed" | "skipped";
	durationMs: number;
	error?: string;
}

export interface TestSuite {
	/**
	 * Run a group of tests with a shared Summa instance.
	 * A fresh instance is created per group.
	 */
	describe(
		group: string,
		fn: (instance: TestInstance) => Array<{ name: string; run: () => Promise<void> }>,
	): void;

	/** Skip a test. */
	skip(name: string, _fn: () => Promise<void>): { name: string; run: () => Promise<void> };

	/** Define a test case. */
	test(name: string, fn: () => Promise<void>): { name: string; run: () => Promise<void> };

	/** Run all registered groups and return stats. */
	run(): Promise<TestSuiteStats>;
}

// =============================================================================
// IMPLEMENTATION
// =============================================================================

export function createTestSuite(options: TestSuiteOptions): TestSuite {
	const groups: Array<{
		group: string;
		fn: (instance: TestInstance) => Array<{ name: string; run: () => Promise<void> }>;
	}> = [];

	const suite: TestSuite = {
		describe(group, fn) {
			groups.push({ group, fn });
		},

		test(name, fn) {
			return { name, run: fn };
		},

		skip(name, _fn) {
			return {
				name,
				run: async () => {
					throw new SkipError();
				},
			};
		},

		async run(): Promise<TestSuiteStats> {
			const stats: TestSuiteStats = {
				totalTests: 0,
				passedTests: 0,
				failedTests: 0,
				skippedTests: 0,
				totalDurationMs: 0,
				tests: [],
			};

			const suiteStart = Date.now();

			for (const { group, fn } of groups) {
				const instance = await getTestInstance({
					adapter: options.adapter,
					currency: options.currency,
					plugins: options.plugins,
					systemAccounts: options.systemAccounts,
				});

				const tests = fn(instance);

				for (const t of tests) {
					stats.totalTests++;
					const start = Date.now();
					try {
						await t.run();
						const duration = Date.now() - start;
						stats.passedTests++;
						stats.tests.push({
							name: t.name,
							group,
							status: "passed",
							durationMs: duration,
						});
					} catch (err) {
						const duration = Date.now() - start;
						if (err instanceof SkipError) {
							stats.skippedTests++;
							stats.tests.push({
								name: t.name,
								group,
								status: "skipped",
								durationMs: duration,
							});
						} else {
							stats.failedTests++;
							stats.tests.push({
								name: t.name,
								group,
								status: "failed",
								durationMs: duration,
								error: err instanceof Error ? err.message : String(err),
							});
						}
					}
				}

				await instance.cleanup();
			}

			stats.totalDurationMs = Date.now() - suiteStart;
			return stats;
		},
	};

	return suite;
}

class SkipError extends Error {
	constructor() {
		super("SKIP");
		this.name = "SkipError";
	}
}
