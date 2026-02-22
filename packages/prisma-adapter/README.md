# @summa-ledger/prisma-adapter

> **Warning**
> This package is under active development and in a **highly experimental stage**. APIs may change without notice. Extensive testing is still pending — **do not use in production** until a stable release is announced.

Prisma Client database adapter for the Summa ledger.

## Installation

```bash
npm install @summa-ledger/prisma-adapter @prisma/client
```

## Usage

```ts
import { createSumma } from "@summa-ledger/summa";
import { prismaAdapter } from "@summa-ledger/prisma-adapter";
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
