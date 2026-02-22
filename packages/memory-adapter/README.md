# @summa-ledger/memory-adapter

> **Warning**
> This package is under active development and in a **highly experimental stage**. APIs may change without notice. Extensive testing is still pending — **do not use in production** until a stable release is announced.

In-memory database adapter for the Summa ledger. Designed for unit testing -- no external database required.

## Installation

```bash
npm install @summa-ledger/memory-adapter
```

## Usage

```ts
import { createSumma } from "@summa-ledger/summa";
import { memoryAdapter } from "@summa-ledger/memory-adapter";

const summa = createSumma({
  database: memoryAdapter(),
  currency: "USD",
  systemAccounts: { world: "@World" },
});
```

### With @summa-ledger/test-utils

```ts
import { getTestInstance } from "@summa-ledger/test-utils";
import { memoryAdapter } from "@summa-ledger/memory-adapter";

const { summa, cleanup } = await getTestInstance({
  adapter: memoryAdapter(),
});

// ... run tests ...

await cleanup();
```

**Note:** This adapter stores all data in memory and is not suitable for production use.

## Documentation

Full documentation available at [https://summa.dev](https://summa.dev).

## License

MIT
