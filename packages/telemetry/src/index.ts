// =============================================================================
// TELEMETRY — Anonymous usage analytics for Summa CLI
// =============================================================================

import { sendEvent, type TelemetryClientOptions } from "./client.js";
import type { EventName, TelemetryEvent } from "./events.js";
import { isTelemetryEnabled } from "./storage.js";

export type { EventName, TelemetryEvent } from "./events.js";
export { createOtelLogger, createRequestTracer, type SummaOtelOptions } from "./otel.js";
export { isTelemetryEnabled, readTelemetryState, writeTelemetryState } from "./storage.js";

export interface TelemetryOptions {
	/** Override the default enabled check. */
	enabled?: boolean;
	/** Custom endpoint URL. */
	endpoint?: string;
	/** Summa CLI version string. */
	version?: string;
}

export interface Telemetry {
	/** Track an event. No-op if telemetry is disabled. */
	track: (event: EventName, properties?: Record<string, unknown>) => void;
}

/**
 * Create a telemetry instance for the CLI.
 *
 * Events are fire-and-forget — they never block the CLI or throw errors.
 * Telemetry is opt-in: disabled by default until the user runs `summa telemetry on`.
 */
export function createTelemetry(options: TelemetryOptions = {}): Telemetry {
	const enabled = options.enabled ?? isTelemetryEnabled();
	const clientOptions: TelemetryClientOptions = {
		endpoint: options.endpoint,
	};

	function track(eventName: EventName, properties: Record<string, unknown> = {}): void {
		if (!enabled) return;

		const event: TelemetryEvent = {
			event: eventName,
			timestamp: new Date().toISOString(),
			version: options.version ?? "unknown",
			nodeVersion: process.version,
			platform: process.platform,
			arch: process.arch,
			properties,
		} as TelemetryEvent;

		// Fire-and-forget — don't await
		void sendEvent(event, clientOptions);
	}

	return { track };
}
