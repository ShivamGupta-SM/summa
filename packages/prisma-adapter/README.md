# @summa/prisma-adapter

Prisma Client database adapter for the Summa ledger.

## Installation

```bash
npm install @summa/prisma-adapter @prisma/client
```

## Usage

```ts
import { createSumma } from "summa";
import { prismaAdapter } from "@summa/prisma-adapter";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const summa = createSumma({
  database: prismaAdapter(prisma),
  currency: "USD",
  systemAccounts: { world: "@World" },
});
```

### Peer Dependencies

- `@prisma/client` ^5.0.0 || ^6.0.0

## Documentation

Full documentation available at [https://summa.dev](https://summa.dev).

## License

MIT
