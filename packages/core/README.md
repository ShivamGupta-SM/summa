# @summa-ledger/core

> **Warning**
> This package is under active development and in a **highly experimental stage**. APIs may change without notice. Extensive testing is still pending — **do not use in production** until a stable release is announced.

Shared types, error system, and utilities for the Summa ledger ecosystem.

## Installation

```bash
npm install @summa-ledger/core
```

## Usage

```ts
import { SummaError, createErrorCodes } from "@summa-ledger/core";
import type { Account, LedgerTransaction, SummaOptions } from "@summa-ledger/core";
```

### Error System

```ts
import { SummaError, BASE_ERROR_CODES } from "@summa-ledger/core";

throw new SummaError("ACCOUNT_NOT_FOUND", "No account for holder");
```

### Sub-path Exports

| Export             | Description                          |
| ------------------ | ------------------------------------ |
| `@summa-ledger/core`      | Core types and error classes         |
| `@summa-ledger/core/db`   | Database adapter interfaces, `SqlExecutor`, pool types, read replicas |
| `@summa-ledger/core/error` | Error codes and `SummaError`        |
| `@summa-ledger/core/logger` | Logger interface                   |
| `@summa-ledger/core/utils` | Internal utilities                  |

## Documentation

Full documentation available at [https://summa.dev](https://summa.dev).

## License

MIT
