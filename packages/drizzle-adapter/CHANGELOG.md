# @summa-ledger/drizzle-adapter

## 0.2.1

### Patch Changes

- [`51a9774`](https://github.com/summa-ledger/summa/commit/51a977446445e57f58b75afcaf90aaccd2203f2b) Thanks [@ShivamGupta-SM](https://github.com/ShivamGupta-SM)! - First npm publish with updated granular access token.

- Updated dependencies [[`51a9774`](https://github.com/summa-ledger/summa/commit/51a977446445e57f58b75afcaf90aaccd2203f2b)]:
  - @summa-ledger/core@0.2.1

## 0.2.0

### Minor Changes

- [`b30ffdc`](https://github.com/summa-ledger/summa/commit/b30ffdc9505de37d29141a0f28ee43643037059e) Thanks [@ShivamGupta-SM](https://github.com/ShivamGupta-SM)! - Initial public release of Summa — event-sourced, double-entry, type-safe financial ledger for TypeScript.

  - Double-entry bookkeeping with balanced DEBIT/CREDIT entries
  - Event sourcing with SHA-256 hash chain verification
  - Two-phase authorization holds (reserve, commit, void)
  - 25+ composable plugins (audit, reconciliation, velocity limits, FX, batch engine, and more)
  - 4 database adapters (Drizzle, Prisma, Kysely, in-memory)
  - TigerBeetle-inspired transient error classification and balancing debits
  - CLI for migrations, integrity verification, and diagnostics
  - Type-safe HTTP client SDK

### Patch Changes

- Updated dependencies [[`b30ffdc`](https://github.com/summa-ledger/summa/commit/b30ffdc9505de37d29141a0f28ee43643037059e)]:
  - @summa-ledger/core@0.2.0
