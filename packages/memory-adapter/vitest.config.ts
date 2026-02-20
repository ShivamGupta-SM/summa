import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
	},
	resolve: {
		alias: {
			"@summa/core": path.resolve(__dirname, "../core/src/index.ts"),
		},
	},
});
