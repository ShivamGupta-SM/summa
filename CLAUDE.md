# Summa — Development Guide for AI Assistants

## Project Overview

Summa is an event-sourced double-entry financial ledger for TypeScript, structured as a pnpm monorepo with Turborepo.

## Architecture

- **@summa/core** — Types, adapter interface (SummaAdapter), errors (SummaError), utils (hash, id, lock, money)
- **summa** — Main package with managers (account, transaction, hold, limit, idempotency, system-accounts), infrastructure (event-store, hash-chain, worker-runner), and 6 plugins
- **@summa/drizzle-adapter** — PostgreSQL adapter via Drizzle ORM (20 tables)
- **@summa/prisma-adapter** — PostgreSQL adapter via Prisma
- **@summa/kysely-adapter** — PostgreSQL adapter via Kysely
- **@summa/memory-adapter** — In-memory adapter for testing (no raw SQL support)
- **@summa/cli** — CLI tool (init, migrate, verify, status)
- **@summa/test-utils** — Test helpers (getTestInstance, assertions)

## Key Patterns

- All managers use raw parameterized SQL ($1, $2 placeholders) through adapter.raw()/adapter.rawMutate()
- Plugins implement the SummaPlugin interface with hooks, workers, and scheduledTasks
- Worker runner uses distributed leasing via worker_lease table
- Double-entry invariant: sum of all debits always equals sum of all credits
- Event sourcing with SHA-256 hash chain per aggregate
- Copy-on-write transactions in memory adapter

## Build & Test

```bash
pnpm install        # Install deps
pnpm build          # Build all packages (turbo)
pnpm test           # Run all tests (vitest)
pnpm lint           # Lint with Biome
pnpm typecheck      # TypeScript check
```

## Important Rules

- Never make destructive git changes (no force push, no reset --hard, no git restore)
- All packages use ESM only (type: "module")
- Build tool is tsdown (not tsc for emit)
- Tab indentation, double quotes, semicolons (Biome config)
- Integration tests need PostgreSQL (via docker compose)
