import { defineConfig } from "tsdown";

export default defineConfig({
	dts: true,
	format: ["esm"],
	entry: [
		"./src/index.ts",
		"./src/db/index.ts",
		"./src/error/index.ts",
		"./src/logger/index.ts",
		"./src/sql/index.ts",
		"./src/utils/index.ts",
	],
	sourcemap: true,
	clean: true,
});
