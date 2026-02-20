# @summa/memory-adapter

In-memory database adapter for the Summa ledger. Designed for unit testing -- no external database required.

## Installation

```bash
npm install @summa/memory-adapter
```

## Usage

```ts
import { createSumma } from "summa";
import { memoryAdapter } from "@summa/memory-adapter";

const summa = createSumma({
  database: memoryAdapter(),
  currency: "USD",
  systemAccounts: { world: "@World" },
});
```

### With @summa/test-utils

```ts
import { getTestInstance } from "@summa/test-utils";
import { memoryAdapter } from "@summa/memory-adapter";

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
