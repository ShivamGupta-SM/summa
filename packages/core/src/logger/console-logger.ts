// =============================================================================
// CONSOLE LOGGER — Built-in SummaLogger backed by console.*
// =============================================================================

import type { SummaLogger } from "../types/config.js";
import { blue, bold, dim, magenta, red, yellow } from "./colors.js";
import { buildRedactKeys, redactData } from "./redact.js";

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

const LEVEL_COLOR: Record<LogLevel, (s: string) => string> = {
	debug: magenta,
	info: blue,
	warn: yellow,
	error: red,
};

export interface ConsoleLoggerOptions {
	/** Minimum log level to emit. Default: `"info"` */
	level?: LogLevel;
	/** Prefix shown before each message. Default: `"Summa"` */
	prefix?: string;
	/** Whether to include ISO timestamps. Default: `true` */
	timestamps?: boolean;
	/** Keys to redact from log data. Values replaced with "[REDACTED]". Default: common PII keys */
	redactKeys?: string[];
}

/**
 * Create a console-based logger implementing `SummaLogger`.
 *
 * @example
 * ```ts
 * import { createConsoleLogger } from "@summa/core/logger";
 *
 * const logger = createConsoleLogger({ level: "debug" });
 * ```
 */
export function createConsoleLogger(options: ConsoleLoggerOptions = {}): SummaLogger {
	const { level = "info", prefix = "Summa", timestamps = true } = options;
	const minPriority = LEVEL_PRIORITY[level];
	const redactKeys = buildRedactKeys(options.redactKeys);

	function emit(lvl: LogLevel, message: string, data?: Record<string, unknown>) {
		if (LEVEL_PRIORITY[lvl] < minPriority) return;

		const parts: string[] = [];
		if (timestamps) {
			parts.push(dim(new Date().toISOString()));
		}
		parts.push(LEVEL_COLOR[lvl](bold(lvl.toUpperCase().padEnd(5))));
		parts.push(`[${prefix}]:`);
		parts.push(message);

		const line = parts.join(" ");
		const method = lvl === "error" ? "error" : lvl === "warn" ? "warn" : "log";

		const safeData = redactData(data, redactKeys);
		if (safeData && Object.keys(safeData).length > 0) {
			console[method](line, safeData);
		} else {
			console[method](line);
		}
	}

	return {
		debug: (message, data) => emit("debug", message, data),
		info: (message, data) => emit("info", message, data),
		warn: (message, data) => emit("warn", message, data),
		error: (message, data) => emit("error", message, data),
	};
}
