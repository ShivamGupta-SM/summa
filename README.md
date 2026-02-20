<p align="center">
  <strong>SUMMA</strong>
</p>

<p align="center">
  The ledger your money deserves.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/summa"><img src="https://img.shields.io/npm/v/summa.svg?style=flat&colorA=18181b&colorB=28CF8D" alt="Version"></a>
  <a href="https://www.npmjs.com/package/summa"><img src="https://img.shields.io/npm/dm/summa.svg?style=flat&colorA=18181b&colorB=28CF8D" alt="Downloads"></a>
  <a href="https://github.com/ShivamGupta-SM/summa/blob/main/LICENSE"><img src="https://img.shields.io/github/license/ShivamGupta-SM/summa?style=flat&colorA=18181b&colorB=28CF8D" alt="License"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-strict-blue?style=flat&colorA=18181b&colorB=28CF8D" alt="TypeScript"></a>
</p>

<p align="center">
  Event-sourced, double-entry, type-safe financial ledger — built for teams that ship financial infrastructure in TypeScript.
</p>

<p align="center">
  <a href="https://summa-docs.vercel.app">Documentation</a> · <a href="https://github.com/ShivamGupta-SM/summa/issues">Issues</a> · <a href="https://www.npmjs.com/package/summa">npm</a>
</p>

---

## Why Summa?

Most "ledger" libraries are toy wrappers around a balance column. Summa is a production-grade financial ledger with real double-entry bookkeeping, an immutable event-sourced audit trail, and a composable plugin system — all with full TypeScript inference from core to edge.

## Features

<table>
<tr>
<td width="33%">

**Double Entry**

Credits and debits enforced at the database level. No silent rounding errors, no unbalanced books.

</td>
<td width="33%">

**Event Sourced**

Every state change is an immutable event. Rebuild account state from any point in time.

</td>
<td width="33%">

**Plugin Ecosystem**

Audit logs, velocity limits, reconciliation, snapshots, scheduled transactions — compose what you need.

</td>
</tr>
<tr>
<td width="33%">

**Multi-ORM**

Drizzle, Prisma, or Kysely. Swap adapters without changing business logic. All backed by PostgreSQL.

</td>
<td width="33%">

**Holds & Freezes**

Create holds, commit or void them. Freeze accounts with reason tracking. All first-class operations.

</td>
<td width="33%">

**Type-Safe**

Full inference through plugins, adapters, and configuration. Catch errors at compile time, not in production.

</td>
</tr>
</table>

## Quick Start

```bash
npm i summa
```

```typescript
import { createSumma } from "summa";

const summa = createSumma({
  database: yourAdapter,
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
// => { balance: 5000, availableBalance: 5000, currency: "USD" }
```

## How It Works

```
01 Configure    →  Set up Summa with your adapter, currency, and plugins.
02 Accounts     →  Open asset, liability, or equity accounts.
03 Transact     →  Post double-entry balanced, immutable transactions.
04 Query        →  Read balances, list events, replay history.
```

## Authorization Holds

Two-phase commits for reserving funds before settlement:

```typescript
// Reserve $50
const hold = await summa.holds.create({
  holderId: "user-123",
  amount: 5000,
  reference: "hold-001",
  description: "Pending charge",
});

// Later — commit or void
await summa.holds.commit({ holdId: hold.id });
// or
await summa.holds.void({ holdId: hold.id });
```

## Event Sourcing & Audit Trail

Every operation is recorded as an immutable event with SHA-256 hash chain verification:

```typescript
const events = await summa.events.getForAggregate("account", accountId);

const result = await summa.events.verifyChain("account", accountId);
console.log(result.valid); // true
```

## Database Adapters

Swap adapters without touching business logic. Same API, same types, any database.

```bash
npm i @summa/drizzle-adapter    # Drizzle ORM
npm i @summa/prisma-adapter     # Prisma
npm i @summa/kysely-adapter     # Kysely
npm i @summa/memory-adapter     # In-memory (testing)
```

All adapters target **PostgreSQL** in production. The memory adapter is provided for unit tests and local development.

## Plugins

Extend Summa with composable, type-safe plugins:

| Plugin | What it does |
|--------|-------------|
| `auditLog` | Structured audit trail for compliance |
| `reconciliation` | Balance reconciliation and drift detection |
| `snapshots` | Point-in-time balance snapshots |
| `velocityLimits` | Daily/monthly transaction limits |
| `holdExpiry` | Auto-expire stale authorization holds |
| `outbox` | Transactional outbox for reliable event publishing |
| `dlqManager` | Dead letter queue for failed event processing |
| `hotAccounts` | High-throughput account optimizations |
| `scheduledTransactions` | Recurring and future-dated transactions |
| `maintenance` | Database maintenance and cleanup tasks |
| `admin` | Administrative operations and controls |
| `openApi` | Auto-generated OpenAPI spec |

## Security

Every layer is hardened — from parameterized queries to cryptographic audit trails.

| | |
|---|---|
| **SQL Injection Prevention** | All queries use parameterized placeholders. No string interpolation ever touches the database. |
| **Concurrency Control** | PostgreSQL advisory locks + `SELECT ... FOR UPDATE` within atomic transactions. No double-spending. |
| **Idempotency** | Every mutation accepts an idempotency key with configurable TTL. Unique reference constraints prevent re-execution. |
| **Tamper Detection** | SHA-256 hash chain per aggregate + block-level checkpoints. A single altered event breaks the chain. |
| **Webhook Signing** | HMAC-SHA256 signatures with timing-safe comparison and configurable tolerance window. |
| **Rate Limiting** | Token bucket limiter with 3 backends (memory, database, Redis). Built-in presets: standard, strict, lenient, burst. |

## Packages

| Package | Description |
|---------|-------------|
| [`summa`](https://www.npmjs.com/package/summa) | Main ledger library |
| `@summa/core` | Core types and database adapter interface |
| `@summa/client` | Type-safe client SDK |
| `@summa/cli` | CLI for migrations and integrity checks |
| `@summa/drizzle-adapter` | Drizzle ORM adapter |
| `@summa/prisma-adapter` | Prisma adapter |
| `@summa/kysely-adapter` | Kysely adapter |
| `@summa/memory-adapter` | In-memory adapter for testing |

## CLI

```bash
npm i -D @summa/cli

summa init              # Interactive project setup wizard
summa generate          # Generate schema for Drizzle/Prisma/Kysely
summa migrate push      # Push schema directly to PostgreSQL
summa migrate status    # Show pending schema changes
summa status            # System dashboard (accounts, integrity, outbox)
summa verify            # Verify balance integrity & hash chains
summa info              # Environment & project diagnostics
summa secret --env      # Generate secrets in .env format
```

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup and guidelines.

```bash
pnpm install && pnpm build
```

## License

[MIT](./LICENSE)
