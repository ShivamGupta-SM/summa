# @summa/core

Shared types, error system, and utilities for the Summa ledger ecosystem.

## Installation

```bash
npm install @summa/core
```

## Usage

```ts
import { SummaError, createErrorCodes } from "@summa/core";
import type { Account, LedgerTransaction, SummaOptions } from "@summa/core";
```

### Error System

```ts
import { SummaError, BASE_ERROR_CODES } from "@summa/core";

throw new SummaError("ACCOUNT_NOT_FOUND", "No account for holder");
```

### Sub-path Exports

| Export             | Description                          |
| ------------------ | ------------------------------------ |
| `@summa/core`      | Core types and error classes         |
| `@summa/core/db`   | Database adapter interfaces, `SqlExecutor`, pool types, read replicas |
| `@summa/core/error` | Error codes and `SummaError`        |
| `@summa/core/logger` | Logger interface                   |
| `@summa/core/utils` | Internal utilities                  |

## Documentation

Full documentation available at [https://summa.dev](https://summa.dev).

## License

MIT
