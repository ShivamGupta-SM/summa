# @summa-ledger/drizzle-adapter

> **Warning**
> This package is under active development and in a **highly experimental stage**. APIs may change without notice. Extensive testing is still pending — **do not use in production** until a stable release is announced.

Drizzle ORM database adapter for the Summa ledger.

## Installation

```bash
npm install @summa-ledger/drizzle-adapter drizzle-orm
```

## Usage

```ts
import { createSumma } from "@summa-ledger/summa";
import { drizzleAdapter } from "@summa-ledger/drizzle-adapter";
import { drizzle } from "drizzle-orm/node-postgres";

const db = drizzle(process.env.DATABASE_URL);

const summa = createSumma({
  database: drizzleAdapter(db),
  currency: "USD",
  systemAccounts: { world: "@World" },
});
```

### Schema Export

The package also exports the Drizzle table schema:

```ts
import { schema } from "@summa-ledger/drizzle-adapter/schema";
```

### Peer Dependencies

- `drizzle-orm` >= 0.41.0
- `pg` ^8.0.0 (optional)

## Documentation

Full documentation available at [https://summa.dev](https://summa.dev).

## License

MIT
