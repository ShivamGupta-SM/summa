import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
  },
  resolve: {
    alias: {
      "@summa/core/logger": path.resolve(__dirname, "../core/src/logger/index.ts"),
      "@summa/core/db": path.resolve(__dirname, "../core/src/db/index.ts"),
      "@summa/core/error": path.resolve(__dirname, "../core/src/error/index.ts"),
      "@summa/core/utils": path.resolve(__dirname, "../core/src/utils/index.ts"),
      "@summa/core": path.resolve(__dirname, "../core/src/index.ts"),
    },
  },
});
