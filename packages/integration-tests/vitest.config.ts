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
			{ find: "summa/plugins", replacement: path.resolve(__dirname, "../summa/src/plugins/index.ts") },
			{ find: "summa/types", replacement: path.resolve(__dirname, "../summa/src/types/index.ts") },
			{ find: "summa", replacement: path.resolve(__dirname, "../summa/src/index.ts") },
			{ find: "@summa/core", replacement: path.resolve(__dirname, "../core/src/index.ts") },
			{ find: "@summa/drizzle-adapter/schema", replacement: path.resolve(__dirname, "../drizzle-adapter/src/schema.ts") },
			{ find: "@summa/drizzle-adapter", replacement: path.resolve(__dirname, "../drizzle-adapter/src/index.ts") },
			{ find: "@summa/test-utils", replacement: path.resolve(__dirname, "../test-utils/src/index.ts") },
		],
	},
});
