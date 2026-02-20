import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30_000,
		hookTimeout: 30_000,
	},
	resolve: {
		alias: {
			"@summa/core": path.resolve(__dirname, "../core/src/index.ts"),
			summa: path.resolve(__dirname, "../summa/src/index.ts"),
			"summa/plugins": path.resolve(__dirname, "../summa/src/plugins/index.ts"),
			"@summa/drizzle-adapter": path.resolve(__dirname, "../drizzle-adapter/src/index.ts"),
			"@summa/drizzle-adapter/schema": path.resolve(
				__dirname,
				"../drizzle-adapter/src/schema.ts",
			),
			"@summa/test-utils": path.resolve(__dirname, "../test-utils/src/index.ts"),
		},
	},
});
