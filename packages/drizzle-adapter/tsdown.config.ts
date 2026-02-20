import { defineConfig } from "tsdown";
export default defineConfig({
  dts: true,
  format: ["esm"],
  entry: ["./src/index.ts", "./src/schema.ts"],
  sourcemap: true,
  clean: true,
});
