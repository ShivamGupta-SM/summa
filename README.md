# Summa

Event-sourced double-entry financial ledger for TypeScript.

## Features

- **Double-Entry Bookkeeping** — Every transaction creates balanced debit/credit entries
- **Event Sourcing** — Immutable audit trail with cryptographic hash chain verification
- **Holds** — Two-phase commits for reserving funds before settlement
- **Velocity Limits** — Configurable daily/monthly transaction limits
- **Idempotency** — Built-in idempotency key support for safe retries
- **Multi-Destination Transfers** — Split payments across multiple recipients
- **Plugin System** — Reconciliation, scheduled transactions, snapshots, and more
- **Database Adapters** — Drizzle, Prisma, Kysely, or in-memory for testing

## Installation

```bash
# Core library
pnpm add summa @summa/core

# Pick a database adapter
pnpm add @summa/drizzle-adapter   # Drizzle ORM
pnpm add @summa/prisma-adapter    # Prisma
pnpm add @summa/kysely-adapter    # Kysely
pnpm add @summa/memory-adapter    # In-memory (testing)
```

## Quick Start

```typescript
import { createSumma } from "summa";

const summa = createSumma({
  adapter: yourAdapter,
  currency: "USD",
});

// Create an account
const account = await summa.accounts.create({
  holderId: "user-123",
  holderType: "individual",
  currency: "USD",
});

// Credit funds
await summa.transactions.credit({
  holderId: "user-123",
  amount: 10000, // $100.00 in cents
  reference: "deposit-001",
  description: "Initial deposit",
});

// Transfer between accounts
await summa.transactions.transfer({
  sourceHolderId: "user-123",
  destinationHolderId: "user-456",
  amount: 5000,
  reference: "transfer-001",
});

// Check balance
const balance = await summa.accounts.getBalance("user-123");
// => { balance: 5000, availableBalance: 5000, currency: "USD", ... }
```

## Holds (Two-Phase Commits)

Reserve funds before settling:

```typescript
// Reserve $50
const hold = await summa.holds.create({
  holderId: "user-123",
  amount: 5000,
  description: "Pending charge",
});

// Later — commit or void
await summa.holds.commit(hold.id);
// or
await summa.holds.void(hold.id);
```

## Event Sourcing & Audit Trail

Every operation is recorded as an immutable event with hash chain verification:

```typescript
// Get all events for an account
const events = await summa.events.getForAggregate(accountId);

// Verify chain integrity
const isValid = await summa.events.verifyChain();
```

## Packages

| Package | Description |
|---------|-------------|
| `summa` | Main ledger library |
| `@summa/core` | Core types and database adapter interface |
| `@summa/cli` | CLI tool for migrations and integrity checks |
| `@summa/drizzle-adapter` | Drizzle ORM adapter |
| `@summa/prisma-adapter` | Prisma adapter |
| `@summa/kysely-adapter` | Kysely adapter |
| `@summa/memory-adapter` | In-memory adapter for testing |

## CLI

```bash
pnpm add -g @summa/cli

summa init          # Initialize configuration
summa migrate       # Run database migrations
summa status        # Check ledger status
summa verify        # Verify hash chain integrity
```

## Development

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run tests
pnpm test

# Run tests with coverage
pnpm test:coverage

# Lint & format
pnpm lint
pnpm lint:fix
pnpm format

# Type check
pnpm typecheck
```

## License

MIT
