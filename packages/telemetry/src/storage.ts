// =============================================================================
// TELEMETRY STORAGE — Persists opt-in/out preference in ~/.summa/telemetry.json
// =============================================================================

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface TelemetryState {
	enabled: boolean;
	/** ISO date when the preference was last changed */
	updatedAt: string;
}

function getSummaDir(): string {
	return join(homedir(), ".summa");
}

function getStatePath(): string {
	return join(getSummaDir(), "telemetry.json");
}

/** Read the user's telemetry preference. Returns null if not set. */
export function readTelemetryState(): TelemetryState | null {
	const statePath = getStatePath();
	if (!existsSync(statePath)) return null;

	try {
		const raw = readFileSync(statePath, "utf-8");
		return JSON.parse(raw) as TelemetryState;
	} catch {
		return null;
	}
}

/** Write the user's telemetry preference. */
export function writeTelemetryState(enabled: boolean): void {
	const dir = getSummaDir();
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	const state: TelemetryState = {
		enabled,
		updatedAt: new Date().toISOString(),
	};

	writeFileSync(getStatePath(), JSON.stringify(state, null, 2), "utf-8");
}

/** Check if telemetry is enabled. Defaults to false (opt-in). */
export function isTelemetryEnabled(): boolean {
	// Environment variable override
	if (process.env.SUMMA_TELEMETRY_DISABLED === "1") return false;
	if (process.env.DO_NOT_TRACK === "1") return false;

	const state = readTelemetryState();
	return state?.enabled ?? false;
}
