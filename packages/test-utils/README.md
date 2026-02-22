# @summa-ledger/test-utils

> **Warning**
> This package is under active development and in a **highly experimental stage**. APIs may change without notice. Extensive testing is still pending — **do not use in production** until a stable release is announced.

Testing utilities and assertions for the Summa ledger.

## Installation

```bash
npm install -D @summa-ledger/test-utils @summa-ledger/memory-adapter
```

## Usage

```ts
import { getTestInstance, assertDoubleEntryBalance } from "@summa-ledger/test-utils";
import { memoryAdapter } from "@summa-ledger/memory-adapter";

const { summa, cleanup } = await getTestInstance({
  adapter: memoryAdapter(),
});

// Create accounts and transactions...
const account = await summa.accounts.create({
  holderId: "user_1",
  holderType: "individual",
});

// Assert the double-entry invariant (all balances sum to zero)
await assertDoubleEntryBalance(summa);

// Cleanup after tests
await cleanup();
```

### Assertions

| Function                     | Description                                     |
| ---------------------------- | ----------------------------------------------- |
| `assertDoubleEntryBalance`   | Verifies all account balances sum to zero        |
| `assertAccountBalance`       | Checks a specific account's expected balance     |
| `assertHashChainValid`       | Validates the event store hash chain integrity   |

### Peer Dependencies

- `vitest` >= 2.0.0 (optional)

## Documentation

Full documentation available at [https://summa.dev](https://summa.dev).

## License

MIT
