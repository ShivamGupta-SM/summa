# summa

Event-sourced double-entry financial ledger for TypeScript.

## Installation

```bash
npm install @summa-ledger/summa
```

## Usage

```ts
import { createSumma } from "@summa-ledger/summa";
import { drizzleAdapter } from "@summa-ledger/drizzle-adapter";

const summa = createSumma({
  database: drizzleAdapter(db),
  currency: "USD",
  systemAccounts: { world: "@World" },
});

// Create an account
const account = await summa.accounts.create({
  holderId: "user_123",
  holderType: "individual",
});

// Post a transaction
const tx = await summa.transactions.create({
  type: "deposit",
  amount: 5000,
  destinationId: "user_123",
});
```

### Sub-path Exports

| Export              | Description                          |
| ------------------- | ------------------------------------ |
| `summa`             | `createSumma` and core re-exports   |
| `summa/plugins`     | Plugin system                        |
| `summa/types`       | Type definitions                     |
| `summa/api`         | API handler utilities                |
| `summa/api/hono`    | Hono framework integration           |
| `summa/api/express` | Express framework integration        |
| `summa/api/fetch`   | Fetch-based handler                  |
| `summa/api/next`    | Next.js integration                  |
| `summa/api/fastify` | Fastify framework integration        |
| `summa/webhooks`    | Webhook support                      |

## Documentation

Full documentation available at [https://summa.dev](https://summa.dev).

## License

MIT
