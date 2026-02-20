import { defineConfig } from "tsdown";
export default defineConfig({
  dts: true,
  format: ["esm"],
  entry: [
    "./src/index.ts",
    "./src/plugins/index.ts",
    "./src/types/index.ts",
    "./src/db/index.ts",
  ],
  sourcemap: true,
  clean: true,
});
