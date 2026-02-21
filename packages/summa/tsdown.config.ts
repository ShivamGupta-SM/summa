import { defineConfig } from "tsdown";
export default defineConfig({
  dts: true,
  format: ["esm"],
  entry: [
    "./src/index.ts",
    "./src/plugins/index.ts",
    "./src/types/index.ts",
    "./src/db/index.ts",
    "./src/config/index.ts",
    "./src/error/index.ts",
    "./src/api/index.ts",
    "./src/api/hono.ts",
    "./src/api/express.ts",
    "./src/api/fetch.ts",
    "./src/api/next.ts",
    "./src/api/fastify.ts",
    "./src/api/elysia.ts",
    "./src/api/encore.ts",
    "./src/webhooks/index.ts",
  ],
  sourcemap: true,
  clean: true,
});
