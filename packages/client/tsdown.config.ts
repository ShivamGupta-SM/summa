import { defineConfig } from "tsdown";
export default defineConfig({
	dts: true,
	format: ["esm"],
	entry: [
		"./src/index.ts",
		"./src/proxy.ts",
		"./src/react.ts",
		"./src/vue.ts",
		"./src/svelte.ts",
	],
	sourcemap: true,
	clean: true,
});
