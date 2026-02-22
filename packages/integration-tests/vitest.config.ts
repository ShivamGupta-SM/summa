import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30_000,
		hookTimeout: 30_000,
		fileParallelism: false,
	},
	resolve: {
		alias: [
			{ find: "@summa-ledger/summa/plugins", replacement: path.resolve(__dirname, "../summa/src/plugins/index.ts") },
			{ find: "@summa-ledger/summa/types", replacement: path.resolve(__dirname, "../summa/src/types/index.ts") },
			{ find: "@summa-ledger/summa", replacement: path.resolve(__dirname, "../summa/src/index.ts") },
			{ find: "@summa-ledger/core/logger", replacement: path.resolve(__dirname, "../core/src/logger/index.ts") },
			{ find: "@summa-ledger/core/db", replacement: path.resolve(__dirname, "../core/src/db/index.ts") },
			{ find: "@summa-ledger/core", replacement: path.resolve(__dirname, "../core/src/index.ts") },
			{ find: "@summa-ledger/drizzle-adapter/schema", replacement: path.resolve(__dirname, "../drizzle-adapter/src/schema.ts") },
			{ find: "@summa-ledger/drizzle-adapter", replacement: path.resolve(__dirname, "../drizzle-adapter/src/index.ts") },
			{ find: "@summa-ledger/test-utils", replacement: path.resolve(__dirname, "../test-utils/src/index.ts") },
		],
	},
});
