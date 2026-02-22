---
"@summa-ledger/summa": minor
"@summa-ledger/core": minor
"@summa-ledger/cli": minor
"@summa-ledger/client": minor
"@summa-ledger/drizzle-adapter": minor
"@summa-ledger/prisma-adapter": minor
"@summa-ledger/kysely-adapter": minor
"@summa-ledger/memory-adapter": minor
"@summa-ledger/message-queue": minor
"@summa-ledger/projections": minor
"@summa-ledger/redis-storage": minor
"@summa-ledger/telemetry": minor
---

Initial public release of Summa — event-sourced, double-entry, type-safe financial ledger for TypeScript.

- Double-entry bookkeeping with balanced DEBIT/CREDIT entries
- Event sourcing with SHA-256 hash chain verification
- Two-phase authorization holds (reserve, commit, void)
- 25+ composable plugins (audit, reconciliation, velocity limits, FX, batch engine, and more)
- 4 database adapters (Drizzle, Prisma, Kysely, in-memory)
- TigerBeetle-inspired transient error classification and balancing debits
- CLI for migrations, integrity verification, and diagnostics
- Type-safe HTTP client SDK
