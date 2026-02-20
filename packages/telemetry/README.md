# @summa/telemetry

Anonymous usage analytics for the Summa CLI.

## Installation

```bash
npm install @summa/telemetry
```

## Usage

```ts
import { createTelemetry } from "@summa/telemetry";

const telemetry = createTelemetry({ version: "0.1.0" });

telemetry.track("cli.command", { command: "migrate" });
```

### Telemetry State

Telemetry is opt-in and disabled by default. Users can enable it via `summa telemetry on`.

```ts
import { isTelemetryEnabled, readTelemetryState, writeTelemetryState } from "@summa/telemetry";

if (isTelemetryEnabled()) {
  // telemetry is active
}
```

Events are fire-and-forget -- they never block the CLI or throw errors.

## Documentation

Full documentation available at [https://summa.dev](https://summa.dev).

## License

MIT
