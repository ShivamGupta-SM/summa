import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
  },
  resolve: {
    alias: {
      "@summa-ledger/core/logger": path.resolve(__dirname, "../core/src/logger/index.ts"),
      "@summa-ledger/core/db": path.resolve(__dirname, "../core/src/db/index.ts"),
      "@summa-ledger/core/error": path.resolve(__dirname, "../core/src/error/index.ts"),
      "@summa-ledger/core/utils": path.resolve(__dirname, "../core/src/utils/index.ts"),
      "@summa-ledger/core": path.resolve(__dirname, "../core/src/index.ts"),
    },
  },
});
