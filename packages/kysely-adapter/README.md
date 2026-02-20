# @summa/kysely-adapter

Kysely database adapter for the Summa ledger.

## Installation

```bash
npm install @summa/kysely-adapter kysely
```

## Usage

```ts
import { createSumma } from "summa";
import { kyselyAdapter } from "@summa/kysely-adapter";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";

const db = new Kysely({
  dialect: new PostgresDialect({ pool: new Pool() }),
});

const summa = createSumma({
  database: kyselyAdapter(db),
  currency: "USD",
  systemAccounts: { world: "@World" },
});
```

### Peer Dependencies

- `kysely` ^0.27.0 || ^0.28.0

## Documentation

Full documentation available at [https://summa.dev](https://summa.dev).

## License

MIT
