import { createSumma, type Summa, type SummaOptions, type SummaPlugin } from "summa";

export interface TestInstanceOptions {
	/** Database adapter (use memoryAdapter for unit tests, drizzleAdapter for integration) */
	adapter: SummaOptions["database"];
	/** Currency. Default: "USD" */
	currency?: string;
	/** System accounts. Default: { world: "@World" } */
	systemAccounts?: SummaOptions["systemAccounts"];
	/** Plugins to enable */
	plugins?: SummaPlugin[];
}

export interface TestInstance {
	/** The summa instance */
	summa: Summa;
	/** Cleanup function -- call in afterEach/afterAll */
	cleanup: () => Promise<void>;
}

export async function getTestInstance(options: TestInstanceOptions): Promise<TestInstance> {
	const summa = createSumma({
		database: options.adapter,
		currency: options.currency ?? "USD",
		systemAccounts: options.systemAccounts ?? { world: "@World" },
		plugins: options.plugins ?? [],
		logger: {
			info: () => {},
			warn: () => {},
			error: () => {},
			debug: () => {},
		},
	});

	// Wait for initialization
	await summa.$context;

	return {
		summa,
		cleanup: async () => {
			await summa.workers.stop();
		},
	};
}
