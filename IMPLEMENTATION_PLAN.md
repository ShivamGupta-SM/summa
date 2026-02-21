# Summa — Better-auth Parity Implementation Plan

Better-auth se inspired features jo summa mein missing hain, prioritized and planned.

---

## 1. i18n Plugin (Error Message Internationalization)

**What:** Multi-locale error messages with auto-detection
**Why:** Better-auth has full i18n plugin — every error code can be translated
**Effort:** ~200 lines

**How:**
- New plugin: `packages/summa/src/plugins/i18n.ts`
- Plugin options accept translations map:
  ```ts
  i18n({
    defaultLocale: "en",
    translations: {
      en: { INSUFFICIENT_BALANCE: "Insufficient balance", ... },
      hi: { INSUFFICIENT_BALANCE: "अपर्याप्त शेष राशि", ... },
    },
    detection: "header" | "cookie" | "callback"
  })
  ```
- Uses `onResponse` hook to intercept error responses and replace message with translated version
- Detection strategies:
  - `header` — parse `Accept-Language` header with quality values
  - `cookie` — read locale from cookie (configurable name)
  - `callback` — `(req) => "hi"` custom function
- Fallback chain: requested locale → default locale → original message
- Export `defineTranslations()` helper for type-safe translation objects
- Base English translations for all core `$ERROR_CODES` shipped by default

**Files:**
- `packages/summa/src/plugins/i18n.ts` — plugin implementation
- `packages/summa/src/plugins/i18n-translations/en.ts` — default English
- `docs/content/docs/plugins/i18n.mdx` — documentation
- Update `packages/summa/src/plugins/index.ts` — export

---

## 2. Reactive Client SDK (React Hooks, Vue Composables, Svelte Stores)

**What:** Framework-specific reactive wrappers with auto-refetch and cache
**Why:** Current React/Vue/Svelte files exist but are basic fetch wrappers — no reactive state, no auto-refetch, no optimistic updates
**Effort:** ~150 lines per framework (enhance existing files)

**How:**

### React (`packages/client/src/react.ts` — enhance existing)
- Add reactive query hooks with caching:
  ```ts
  const { data, isLoading, error, refetch } = useSummaQuery(
    (client) => client.accounts.getBalance("holder-1")
  )
  ```
- Add mutation hooks with optimistic updates:
  ```ts
  const { mutate, isPending } = useSummaMutation(
    (client) => client.transactions.transfer(params),
    { onSuccess: () => balanceQuery.refetch() }
  )
  ```
- Internal atom-based state (Map of query keys → state)
- Auto-refetch on window focus (configurable)
- Stale-while-revalidate pattern
- `SummaProvider` already exists — enhance context value

### Vue (`packages/client/src/vue.ts` — enhance existing)
- Same pattern with Vue `ref()` / `computed()`:
  ```ts
  const { data, isLoading, error } = useSummaQuery(
    (client) => client.accounts.getBalance("holder-1")
  )
  ```
- `watchEffect` for auto-refetch
- `provide/inject` pattern (already exists)

### Svelte (`packages/client/src/svelte.ts` — enhance existing)
- Svelte writable stores:
  ```ts
  const balance = summa.query((client) => client.accounts.getBalance("holder-1"))
  // $balance.data, $balance.isLoading, $balance.error
  ```
- Derived stores for computed values
- Auto-subscription cleanup

**Files:**
- `packages/client/src/react.ts` — enhance
- `packages/client/src/vue.ts` — enhance
- `packages/client/src/svelte.ts` — enhance
- `docs/content/docs/client-sdk.mdx` — update with reactive examples

---

## 3. Organization / Multi-Tenant Plugin

**What:** First-class org/team/member/invite primitives
**Why:** Better-auth's most powerful plugin — orgs, teams, invites, roles per org
**Effort:** ~600-800 lines

**How:**
- New plugin: `packages/summa/src/plugins/organization.ts`
- Schema — 4 new tables:
  ```
  organization:        id, name, slug, metadata, createdAt
  organization_member: id, organizationId, userId, role, createdAt
  organization_invite: id, organizationId, email, role, token, expiresAt, status
  team:                id, organizationId, name, createdAt
  ```
- Plugin scopes all account/transaction queries by `organizationId`
- Active organization set via header (`X-Organization-Id`) or config
- Uses `onRequest` hook to inject org context into every request
- `operationHooks.before` validates org membership before any operation

**Endpoints:**
```
POST   /organizations                    Create org
GET    /organizations/:slug              Get org
PATCH  /organizations/:slug              Update org
DELETE /organizations/:slug              Delete org
POST   /organizations/:slug/members      Add member
DELETE /organizations/:slug/members/:id  Remove member
PATCH  /organizations/:slug/members/:id  Update role
GET    /organizations/:slug/members      List members
POST   /organizations/:slug/invites      Create invite
POST   /invites/:token/accept            Accept invite
DELETE /organizations/:slug/invites/:id  Cancel invite
```

**Options:**
```ts
organization({
  allowUserToCreateOrg: true,
  orgLimit: 5,
  memberLimit: 50,
  creatorRole: "owner",
  roles: ["owner", "admin", "member", "viewer"],
  defaultRole: "member",
})
```

**Files:**
- `packages/summa/src/plugins/organization.ts`
- `docs/content/docs/plugins/organization.mdx`
- Update plugin exports

---

## 4. Impersonation in Admin Plugin

**What:** Admin can act as any holder — see their balances, simulate transactions
**Why:** Better-auth has full impersonation with session tracking
**Effort:** ~80-100 lines (extend existing admin plugin)

**How:**
- Add to existing `packages/summa/src/plugins/admin.ts`:
- New endpoints:
  ```
  POST /admin/impersonate/:holderId     Start impersonation
  POST /admin/impersonate/stop          Stop impersonation
  ```
- Impersonation sets a response header/cookie: `X-Summa-Impersonating: holder-123`
- All subsequent requests with this header scope queries to that holder
- Audit log records: `{ action: "impersonate.start", actor: "admin-1", target: "holder-123" }`
- Uses `onRequest` hook to detect impersonation header and rewrite request context
- `onResponse` adds `X-Summa-Impersonated-By` header for client awareness

**Files:**
- `packages/summa/src/plugins/admin.ts` — extend
- `docs/content/docs/plugins/admin.mdx` — update

---

## 5. Account Freeze Auto-Expiry

**What:** Freeze with TTL — auto-unfreeze after duration
**Why:** Better-auth has ban with expiration — same pattern
**Effort:** ~60-80 lines

**How:**
- Extend account freeze to accept `expiresAt` or `expiresIn`:
  ```ts
  summa.accounts.freeze("holder-1", {
    reason: "Suspicious activity",
    actor: "system",
    expiresAt: new Date("2025-03-01"),
    // or: expiresIn: "48h"
  })
  ```
- Add `frozenUntil` column to `account_balance` table (nullable timestamp)
- Modify `hold-expiry` plugin (or create new `freeze-expiry` worker) to check `frozenUntil`
- Worker polls every minute, auto-unfreezes expired accounts
- Audit log records auto-unfreeze events

**Files:**
- `packages/summa/src/managers/account-manager.ts` — extend freeze
- `packages/summa/src/plugins/hold-expiry.ts` — add freeze expiry worker, or new plugin
- Schema update for `account_balance.frozenUntil`

---

## 6. MCP Plugin (Model Context Protocol)

**What:** Expose ledger as MCP tools for AI agents
**Why:** Better-auth has MCP plugin — AI agents can manage auth. Same for ledger.
**Effort:** ~200-250 lines

**How:**
- New plugin: `packages/summa/src/plugins/mcp.ts`
- Exposes ledger operations as MCP tools:
  ```
  summa_get_balance       — Get account balance
  summa_list_accounts     — List accounts with filters
  summa_get_transaction   — Get transaction details
  summa_list_transactions — List transactions
  summa_transfer          — Transfer between accounts
  summa_get_statement     — Generate account statement
  summa_verify_equation   — Verify accounting equation
  ```
- MCP resource for real-time balance:
  ```
  summa://accounts/{holderId}/balance
  ```
- Uses `@modelcontextprotocol/sdk` package
- Plugin exposes `getMcpServer()` method that returns configured MCP server
- Authorization callback for tool-level access control

**Files:**
- `packages/summa/src/plugins/mcp.ts`
- `docs/content/docs/plugins/mcp.mdx`

---

## 7. MySQL Dialect & Adapter

**What:** Real MySQL support (interface already exists)
**Why:** Better-auth supports MySQL — many teams use it
**Effort:** ~150-200 lines

**How:**
- Implement `packages/core/src/db/dialects/mysql.ts`:
  - Parameter placeholder: `?` instead of `$1`
  - No advisory locks (use `GET_LOCK()` / `RELEASE_LOCK()`)
  - No `RETURNING` — use `LAST_INSERT_ID()`
  - Timestamp handling: `NOW()` vs `now()`
  - JSON column type: `JSON` (native MySQL 8+)
- Extend Kysely adapter to support MySQL dialect
- Extend Drizzle adapter to support `drizzle-orm/mysql-core`
- Schema generation in CLI for MySQL syntax

**Files:**
- `packages/core/src/db/dialects/mysql.ts`
- `packages/kysely-adapter/` — extend for MySQL
- `packages/drizzle-adapter/` — extend for MySQL
- `packages/cli/src/commands/migrate.ts` — MySQL DDL

**Limitations:**
- No advisory locks in same style — use named locks
- `SELECT ... FOR UPDATE` works natively
- Hash chain / event sourcing works without changes

---

## 8. SQLite Dialect & Adapter

**What:** SQLite support for local dev, testing, edge deployments
**Why:** Better-auth supports it — great for prototyping
**Effort:** ~120-150 lines

**How:**
- Implement `packages/core/src/db/dialects/sqlite.ts`:
  - Parameter placeholder: `?`
  - No advisory locks (use `BEGIN EXCLUSIVE`)
  - No `FOR UPDATE` (entire DB locks on write)
  - Timestamps as ISO strings
  - No JSON column — use TEXT with JSON serialization
- Extend Kysely adapter for `better-sqlite3` dialect
- Extend Drizzle adapter for `drizzle-orm/better-sqlite3`
- CLI migration generation for SQLite syntax

**Files:**
- `packages/core/src/db/dialects/sqlite.ts`
- Adapter extensions
- CLI DDL generation

**Limitations:**
- No real concurrent writes — fine for dev/testing
- No `BIGINT` — use `INTEGER` (53-bit safe)
- Advisory locks emulated via exclusive transactions

---

## 9. Interactive CLI Init Wizard

**What:** Guided setup like better-auth's `init` command
**Why:** Current `summa init` is basic — better-auth auto-detects framework, installs packages
**Effort:** ~200-250 lines (enhance existing)

**How:**
- Enhance `packages/cli/src/commands/init.ts`:
  1. **Detect framework** — scan package.json for next, express, hono, elysia, fastify, encore
  2. **Choose database** — PostgreSQL (default), MySQL, SQLite
  3. **Choose adapter** — Drizzle (recommended), Prisma, Kysely
  4. **Choose plugins** — multi-select checklist of all 23 plugins
  5. **Generate config** — `summa.config.ts` with selected plugins
  6. **Generate schema** — run `summa generate` automatically
  7. **Install packages** — auto-run `pnpm add @summa/summa @summa/drizzle-adapter ...`
  8. **Generate client** — create client setup file for detected framework
  9. **Print next steps** — clear instructions

- Use `@clack/prompts` for beautiful terminal UI (better-auth uses similar)

**Files:**
- `packages/cli/src/commands/init.ts` — enhance
- `packages/cli/src/generators/` — new folder for code generators

---

## 10. OpenAPI Viewer in Docs Site

**What:** Live API reference with Scalar/Swagger UI embedded in docs
**Why:** Better-auth has Scalar integration — interactive API explorer
**Effort:** ~50-80 lines

**How:**
- `open-api` plugin already generates the spec
- Add Scalar component to docs site:
  ```tsx
  // docs/app/api-reference/page.tsx
  import { ApiReference } from "@scalar/nextjs-api-reference"
  export default function Page() {
    return <ApiReference spec={{ url: "/openapi.json" }} />
  }
  ```
- Generate static `openapi.json` at build time from plugin output
- Add link in docs sidebar navigation

**Files:**
- `docs/app/api-reference/page.tsx` — new page
- `docs/public/openapi.json` — generated spec
- `docs/lib/source.ts` — add to navigation

---

## 11. Custom Model/Field Name Mapping

**What:** Let users rename tables and columns
**Why:** Better-auth has `modelName` and `fields` mapping for every model
**Effort:** ~100-150 lines

**How:**
- Add to SummaOptions:
  ```ts
  createSumma({
    modelNames: {
      accountBalance: "accounts",
      transactionRecord: "transactions",
      entryRecord: "journal_entries",
    },
    fieldNames: {
      accountBalance: {
        holderId: "user_id",
        holderType: "account_type",
      }
    }
  })
  ```
- Adapter layer resolves names via a `ModelResolver`:
  ```ts
  interface ModelResolver {
    getModelName(internal: string): string
    getFieldName(model: string, internal: string): string
  }
  ```
- All managers and plugins use resolver instead of hardcoded names
- CLI schema generation respects custom names
- Zero runtime cost — resolved once at init

**Files:**
- `packages/core/src/db/model-resolver.ts` — new
- `packages/summa/src/config/index.ts` — accept mapping options
- All managers — use resolver

---

## 12. Error Documentation Links

**What:** Every error response includes a `docs` URL
**Why:** Better-auth auto-links errors to reference page
**Effort:** ~20-30 lines

**How:**
- Modify `SummaError` class:
  ```ts
  class SummaError extends Error {
    get docsUrl() {
      return `https://summa.dev/docs/error-codes#${this.code.toLowerCase()}`
    }
    toJSON() {
      return { code, message, status, docs: this.docsUrl }
    }
  }
  ```
- API handler includes `docs` field in error responses:
  ```json
  {
    "error": {
      "code": "INSUFFICIENT_BALANCE",
      "message": "Account has insufficient funds",
      "docs": "https://summa.dev/docs/error-codes#insufficient_balance"
    }
  }
  ```
- Configurable base URL in options

**Files:**
- `packages/core/src/error/index.ts` — extend SummaError
- `packages/summa/src/api/handler.ts` — include in response

---

## 13. Structured Test Suite Runner

**What:** Better test utils with suite grouping, timing, stats
**Why:** Better-auth has `createTestSuite` with migration stats and timing
**Effort:** ~100-120 lines

**How:**
- Enhance `packages/test-utils/`:
  ```ts
  const suite = createTestSuite({
    adapter: memoryAdapter(),
    plugins: [auditLog(), outbox()],
  })

  suite.describe("transfers", (summa) => {
    suite.test("basic transfer", async () => { ... })
    suite.test("insufficient balance", async () => { ... })
  })

  // Auto cleanup between tests
  // Timing stats per test
  // Migration tracking
  ```
- Assert helpers already exist — add more:
  ```ts
  assertTransactionCreated(ctx, { from, to, amount })
  assertHoldCommitted(ctx, holdId)
  assertAuditLogContains(ctx, { action, actor })
  assertEventChainValid(ctx, aggregateType, aggregateId)
  ```
- Plugin-specific test helpers (e.g., `assertApprovalPending`)

**Files:**
- `packages/test-utils/src/suite.ts` — new
- `packages/test-utils/src/assertions.ts` — enhance
- `docs/content/docs/testing.mdx` — update

---

## Priority Order

| # | Feature | Effort | Impact | Dependencies |
|---|---------|--------|--------|-------------|
| 1 | i18n Plugin | Small | High | None |
| 2 | Error Documentation Links | Tiny | Medium | None |
| 3 | Account Freeze Auto-Expiry | Small | Medium | None |
| 4 | Impersonation in Admin | Small | Medium | None |
| 5 | Reactive Client SDK | Medium | High | None |
| 6 | OpenAPI Viewer in Docs | Small | Medium | None |
| 7 | Interactive CLI Init Wizard | Medium | High | None |
| 8 | Organization / Multi-Tenant Plugin | Large | High | None |
| 9 | MCP Plugin | Medium | Medium | None |
| 10 | Custom Model/Field Name Mapping | Medium | Medium | None |
| 11 | MySQL Dialect & Adapter | Medium | Medium | None |
| 12 | SQLite Dialect & Adapter | Medium | Medium | None |
| 13 | Structured Test Suite Runner | Small | Medium | None |

---

**Note:** RBAC / Access Control plugin is intentionally excluded from this plan.
**Note:** Redis storage already exists at `packages/redis-storage/`.
**Note:** React/Vue/Svelte clients already exist but need reactive enhancement (item 5).
