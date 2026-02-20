import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		coverage: {
			provider: "v8",
			reporter: ["text", "lcov", "json-summary"],
			include: ["packages/*/src/**/*.ts"],
			exclude: ["**/__tests__/**", "**/*.test.ts", "**/test-utils/**"],
			thresholds: {
				lines: 80,
				branches: 75,
				functions: 80,
				statements: 80,
			},
		},
	},
});
