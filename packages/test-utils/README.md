# @summa/test-utils

Testing utilities and assertions for the Summa ledger.

## Installation

```bash
npm install -D @summa/test-utils @summa/memory-adapter
```

## Usage

```ts
import { getTestInstance, assertDoubleEntryBalance } from "@summa/test-utils";
import { memoryAdapter } from "@summa/memory-adapter";

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
