<h1 align="center">
  <br/>
  <img src="https://raw.githubusercontent.com/summa-ledger/summa/main/.github/logo.svg" alt="Summa" width="48" height="48" />
  <br/>
  Summa
  <br/>
</h1>

<p align="center">
  <b>The ledger your money deserves.</b>
</p>

<p align="center">
  Event-sourced, double-entry, type-safe financial ledger<br/>
  built for teams that ship financial infrastructure in TypeScript.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@summa-ledger/summa"><img src="https://img.shields.io/npm/v/@summa-ledger/summa.svg?style=flat&colorA=18181b&colorB=10b981" alt="Version"></a>
  <a href="https://www.npmjs.com/package/@summa-ledger/summa"><img src="https://img.shields.io/npm/dm/@summa-ledger/summa.svg?style=flat&colorA=18181b&colorB=10b981" alt="Downloads"></a>
  <a href="https://github.com/summa-ledger/summa/blob/main/LICENSE"><img src="https://img.shields.io/github/license/summa-ledger/summa?style=flat&colorA=18181b&colorB=10b981" alt="License"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-strict-blue?style=flat&colorA=18181b&colorB=10b981" alt="TypeScript"></a>
</p>

<p align="center">
  <a href="https://summa-docs.vercel.app/docs">Documentation</a> &nbsp;·&nbsp;
  <a href="https://summa-docs.vercel.app/docs/getting-started">Getting Started</a> &nbsp;·&nbsp;
  <a href="https://github.com/summa-ledger/summa/issues">Issues</a> &nbsp;·&nbsp;
  <a href="https://www.npmjs.com/package/@summa-ledger/summa">npm</a>
</p>

<br/>

---

<br/>

> [!WARNING]
> **Experimental** — Summa is under active development and in a highly experimental stage. APIs may change without notice. Extensive testing is still pending. **Do not use in production** until a stable release is announced.

<br/>

## Why Summa?

Most "ledger" libraries are toy wrappers around a balance column. Summa is a **production-grade financial ledger** with real double-entry bookkeeping, an immutable event-sourced audit trail, and a composable plugin system — all with full TypeScript inference from core to edge.

Every mutation produces an immutable event with a **SHA-256 hash chain** for tamper detection — the same cryptographic verification used in blockchain systems, without the overhead.

| Challenge | How Summa solves it |
|---|---|
| **Double-spending** | Pessimistic locks + balance checks in a single database transaction |
| **Lost transactions** | Event sourcing with append-only log — nothing is ever deleted |
| **Audit requirements** | Cryptographic hash chain verifies no event was modified or removed |
| **High-traffic accounts** | Hot accounts, mega CTE combined writes, and transaction batching for 100,000+ TPS |
| **Network retries** | Built-in idempotency keys prevent duplicate transactions |
| **Partial failures** | Two-phase holds: reserve first, commit or void later |
| **Data inconsistency** | Automated reconciliation compares balances against entry records |

<br/>

## Features

<table>
<tr>
<td width="50%" valign="top">

### Double-Entry Bookkeeping

Every transaction creates balanced DEBIT and CREDIT entries. The sum of all entries is always zero. Enforced at the database level — no silent rounding errors, no unbalanced books.

</td>
<td width="50%" valign="top">

### Event Sourcing

Immutable append-only event log with SHA-256 hash chain. Every state change recorded. Rebuild account state from any point in time. Full audit trail for every mutation.

</td>
</tr>
<tr>
<td width="50%" valign="top">

### Two-Phase Holds

Reserve funds before settlement. Supports partial capture, void, expiry, and multi-destination splits. Perfect for payment pre-auth, hotel bookings, and ride-hailing.

</td>
<td width="50%" valign="top">

### 21 Built-in Plugins

Reconciliation, snapshots, velocity limits, audit log, period close, financial reporting, FX engine, GL/sub-ledger, approval workflows, batch import, accrual accounting, and more.

</td>
</tr>
<tr>
<td width="50%" valign="top">

### Idempotency

Built-in idempotency keys with configurable TTL. Safe retries with no double-posting, even under network failures or load balancer timeouts.

</td>
<td width="50%" valign="top">

### Security Hardened

Parameterized queries, advisory locks, HMAC-SHA256 webhooks, timing-safe comparison, token bucket rate limiting. Every layer is hardened.

</td>
</tr>
<tr>
<td width="50%" valign="top">

### Multi-Destination Transfers

Split payments across multiple recipients in a single atomic transaction. One idempotency key, one event, fully balanced entries.

</td>
<td width="50%" valign="top">

### 4 Database Adapters

Drizzle ORM, Prisma, Kysely, or in-memory for testing. Swap adapters without changing business logic. All backed by PostgreSQL.

</td>
</tr>
<tr>
<td width="50%" valign="top">

### Chart of Accounts & Journal Entries

Full accounting primitives — account types (asset/liability/equity/revenue/expense), hierarchical account trees, account codes, and N-leg journal entries for complex multi-party transactions.

</td>
<td width="50%" valign="top">

### Multi-Currency & FX

Cross-currency transfers with exchange rates, FX rate caching and quotes, gain/loss tracking. Create accounts in any supported currency with automatic rate conversion.

</td>
</tr>
</table>

<br/>

## Quick Start

```bash
npm i @summa-ledger/summa @summa-ledger/core @summa-ledger/drizzle-adapter drizzle-orm
```

**1. Configure**

```ts
import { createSumma } from "@summa-ledger/summa";
import { drizzleAdapter } from "@summa-ledger/drizzle-adapter";
import { auditLog, reconciliation, velocityLimits } from "@summa-ledger/summa/plugins";
import { drizzle } from "drizzle-orm/node-postgres";

const db = drizzle(process.env.DATABASE_URL!);

export const summa = createSumma({
  database: drizzleAdapter(db),
  currency: "USD",
  plugins: [auditLog(), reconciliation(), velocityLimits()],
});
```

**2. Create accounts**

```ts
await summa.accounts.create({
  holderId: "user_123",
  holderType: "individual",
  currency: "USD",
});

await summa.accounts.create({
  holderId: "merchant_1",
  holderType: "organization",
  currency: "USD",
});
```

**3. Move money**

```ts
// Credit $100 (system → user)
await summa.transactions.credit({
  holderId: "user_123",
  amount: 100_00,
  reference: "deposit-001",
});

// Transfer $50 (user → merchant)
await summa.transactions.transfer({
  sourceHolderId: "user_123",
  destinationHolderId: "merchant_1",
  amount: 50_00,
  reference: "order-001",
});
```

**4. Query balances**

```ts
const balance = await summa.accounts.getBalance("user_123");
// => { balance: 5000, availableBalance: 5000, currency: "USD" }
```

<br/>

## Authorization Holds

Two-phase commits for reserving funds before settlement:

```ts
// Place a hold on funds
const hold = await summa.holds.create({
  holderId: "user_123",
  amount: 15_000, // $150.00
  reference: "hold-001",
  description: "Hotel reservation #4821",
  expiresAt: new Date("2025-03-15"),
});

// Later — commit with final amount
await summa.holds.commit({
  holdId: hold.id,
  amount: 12_500, // Final charge: $125.00
});

// Or void to release the funds
await summa.holds.void({ holdId: hold.id });
```

<br/>

## Event Sourcing & Integrity

Every operation is recorded as an immutable event with SHA-256 hash chain verification:

```ts
// Replay events to rebuild state
const events = await summa.events.getForAggregate("account", accountId);

for (const event of events) {
  console.log(event.type, event.data);
  // "transaction.created" { amount: 5000, ... }
  // "hold.committed"      { holdId: "hld_...", ... }
  // "account.frozen"      { reason: "compliance" }
}

// Verify chain integrity
const result = await summa.events.verifyChain("account", accountId);
console.log(result.valid); // true — no events tampered
```

<br/>

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Your Application                                            │
│  API routes · Workers · Cron jobs                            │
├──────────────────────────────────────────────────────────────┤
│  Summa API                                                   │
│  accounts · chartOfAccounts · transactions · journal         │
│  holds · events · limits · corrections                       │
├──────────────────────────────────────────────────────────────┤
│  Plugin System                                               │
│  audit · reconciliation · snapshots · velocity · holdExpiry  │
│  outbox · dlq · hot · scheduled · admin · periodClose        │
│  reporting · fxEngine · glSubLedger · approvalWorkflow       │
│  batchImport · accrualAccounting · observability · statements│
├──────────────────────────────────────────────────────────────┤
│  Database Adapters                                           │
│  Drizzle · Prisma · Kysely · Memory                          │
└──────────────────────────────────────────────────────────────┘
```

<br/>

## Database Adapters

Swap adapters without touching business logic. Same API, same types, any database.

```bash
npm i @summa-ledger/drizzle-adapter    # Drizzle ORM
npm i @summa-ledger/prisma-adapter     # Prisma
npm i @summa-ledger/kysely-adapter     # Kysely
npm i @summa-ledger/memory-adapter     # In-memory (testing)
```

All adapters target **PostgreSQL** in production. The memory adapter is provided for unit tests and local development.

<br/>

## Plugins

Extend Summa with composable, type-safe plugins:

| Plugin | What it does |
|---|---|
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
| `periodClose` | Lock accounting periods for compliance |
| `financialReporting` | Trial balance, balance sheet, income statement |
| `fxEngine` | FX rate caching, quotes, and gain/loss tracking |
| `glSubLedger` | GL / sub-ledger separation with reconciliation |
| `approvalWorkflow` | Maker-checker dual authorization |
| `batchImport` | Bulk CSV/JSON transaction import |
| `accrualAccounting` | Revenue/expense recognition over time |
| `batchEngine` | TigerBeetle-inspired transaction batching for 100,000+ TPS |
| `identity` | KYC identity management with AES-256-GCM PII tokenization |
| `apiKeys` | SHA-256 hashed key management with scoped permissions |
| `balanceMonitor` | Real-time condition-based balance alerts |
| `backup` | Automated PostgreSQL backups with S3 storage |
| `search` | Native PostgreSQL full-text search with optional Typesense and Meilisearch backends |
| `webhookDelivery` | Webhook endpoint management with delivery log |
| `dataRetention` | Configurable cleanup policies for operational data |

<br/>

## Security

Every layer is hardened — from parameterized queries to cryptographic audit trails.

| Layer | Threat | Defense |
|---|---|---|
| **SQL** | Injection | Parameterized placeholders (`$1, $2`). Column names quoted. No string interpolation. |
| **Concurrency** | Double-spending | `pg_advisory_xact_lock` + `SELECT ... FOR UPDATE` in atomic transactions. |
| **Replay** | Duplicates | Idempotency keys with configurable TTL. Unique reference constraints. |
| **Tampering** | Modified events | SHA-256 hash chain per aggregate + block-level checkpoints. |
| **Webhooks** | Forged payloads | HMAC-SHA256 with timing-safe comparison. Configurable tolerance window. |
| **Rate Limiting** | Brute force | Token bucket with 3 backends. 4 presets: standard, strict, lenient, burst. |
| **Overdraft** | Negative balances | Balance checked inside transaction lock — no TOCTOU gap. |
| **Freeze** | Compromised accounts | `freeze()` blocks all operations. Records actor and reason. |

<br/>

## Packages

| Package | Description |
|---|---|
| [`summa`](packages/summa) | Main ledger library with all managers and plugins |
| [`@summa-ledger/core`](packages/core) | Core types, adapter interface, plugin interface |
| [`@summa-ledger/cli`](packages/cli) | CLI for migrations, integrity checks, diagnostics |
| [`@summa-ledger/drizzle-adapter`](packages/drizzle-adapter) | Drizzle ORM adapter |
| [`@summa-ledger/prisma-adapter`](packages/prisma-adapter) | Prisma adapter |
| [`@summa-ledger/kysely-adapter`](packages/kysely-adapter) | Kysely adapter |
| [`@summa-ledger/memory-adapter`](packages/memory-adapter) | In-memory adapter for testing |
| [`@summa-ledger/client`](packages/client) | Type-safe HTTP client SDK |

<br/>

## CLI

```bash
npm i -D @summa-ledger/cli
```

```bash
summa init              # Interactive project setup wizard
summa generate          # Generate schema for Drizzle/Prisma/Kysely
summa migrate push      # Push schema directly to PostgreSQL
summa migrate status    # Show pending schema changes
summa status            # System dashboard (accounts, integrity, outbox)
summa verify            # Verify balance integrity & hash chains
summa verify --chain    # Deep hash chain verification per aggregate
summa info              # Environment & project diagnostics
summa secret --env      # Generate secrets in .env format
```

<br/>

## Client SDK

When Summa runs as a standalone service, use the type-safe HTTP client:

```ts
import { createSummaClient } from "@summa-ledger/client";

const client = createSummaClient({
  baseURL: "http://localhost:3000/api/ledger",
  headers: { Authorization: `Bearer ${process.env.LEDGER_API_KEY}` },
});

const account = await client.accounts.create({ ... });
const txn = await client.transactions.transfer({ ... });
const balance = await client.accounts.getBalance("user_123");
```

<br/>

## Development

```bash
pnpm install        # Install dependencies
pnpm dev            # Run all packages in dev mode
pnpm build          # Build all packages
pnpm test           # Run unit tests
pnpm typecheck      # Type check all packages
pnpm lint           # Lint with Biome
```

<br/>

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup and guidelines.

<br/>

## License

[MIT](./LICENSE)
