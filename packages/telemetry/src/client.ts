// =============================================================================
// TELEMETRY CLIENT — Fire-and-forget HTTP client
// =============================================================================

import type { TelemetryEvent } from "./events.js";

const DEFAULT_ENDPOINT = "https://telemetry.summa.dev/v1/events";
const TIMEOUT_MS = 1000;

export interface TelemetryClientOptions {
	endpoint?: string;
	timeout?: number;
}

/** Send a telemetry event. Fire-and-forget — never throws. */
export async function sendEvent(
	event: TelemetryEvent,
	options: TelemetryClientOptions = {},
): Promise<void> {
	const { endpoint = DEFAULT_ENDPOINT, timeout = TIMEOUT_MS } = options;

	try {
		await fetch(endpoint, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(event),
			signal: AbortSignal.timeout(timeout),
		});
	} catch {
		// Silently ignore — telemetry must never affect CLI behavior
	}
}
