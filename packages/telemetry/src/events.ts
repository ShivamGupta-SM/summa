// =============================================================================
// TELEMETRY EVENTS — Typed event definitions for CLI analytics
// =============================================================================

export interface BaseEvent {
	/** ISO timestamp */
	timestamp: string;
	/** Summa CLI version */
	version: string;
	/** Node.js version */
	nodeVersion: string;
	/** OS platform */
	platform: string;
	/** OS architecture */
	arch: string;
}

export interface CliInitEvent extends BaseEvent {
	event: "cli.init";
	properties: {
		adapter: string;
		plugins: string[];
	};
}

export interface CliGenerateEvent extends BaseEvent {
	event: "cli.generate";
	properties: {
		adapter: string;
		tableCount: number;
	};
}

export interface CliMigrateEvent extends BaseEvent {
	event: "cli.migrate";
	properties: {
		direction: "up" | "down";
	};
}

export interface CliInfoEvent extends BaseEvent {
	event: "cli.info";
	properties: Record<string, never>;
}

export interface CliVerifyEvent extends BaseEvent {
	event: "cli.verify";
	properties: {
		success: boolean;
	};
}

export interface CliStatusEvent extends BaseEvent {
	event: "cli.status";
	properties: Record<string, never>;
}

export type TelemetryEvent =
	| CliInitEvent
	| CliGenerateEvent
	| CliMigrateEvent
	| CliInfoEvent
	| CliVerifyEvent
	| CliStatusEvent;

export type EventName = TelemetryEvent["event"];
