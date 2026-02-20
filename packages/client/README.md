# @summa/client

Type-safe HTTP client SDK for the Summa ledger API.

## Installation

```bash
npm install @summa/client
```

## Usage

```ts
import { createSummaClient } from "@summa/client";

const client = createSummaClient({
  baseURL: "http://localhost:3000/api/ledger",
  headers: { Authorization: "Bearer token" },
});

const account = await client.accounts.create({
  holderId: "user_123",
  holderType: "user",
});

const balance = await client.accounts.getBalance("user_123");
```

### Framework Integrations

```ts
// React
import { createSummaClient } from "@summa/client/react";

// Vue
import { createSummaClient } from "@summa/client/vue";

// Svelte
import { createSummaClient } from "@summa/client/svelte";
```

### Proxy Client

```ts
import { createSummaProxyClient } from "@summa/client/proxy";
```

## Documentation

Full documentation available at [https://summa.dev](https://summa.dev).

## License

MIT
