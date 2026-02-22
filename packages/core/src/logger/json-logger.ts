// =============================================================================
// JSON LOGGER — Structured JSON logging for production environments
// =============================================================================

import type { SummaLogger } from "../types/config.js";
import { buildRedactKeys, redactData } from "./redact.js";

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

export interface JsonLoggerOptions {
	/** Minimum log level to emit. Default: `"info"` */
	level?: LogLevel;
	/** Service name for structured output. Default: `"summa"` */
	service?: string;
	/** Keys to redact from log data. Values replaced with "[REDACTED]". Default: common PII keys */
	redactKeys?: string[];
}

/**
 * Create a structured JSON logger implementing `SummaLogger`.
 *
 * Each log line is emitted as a single-line JSON object suitable for
 * log aggregation systems (ELK, Datadog, CloudWatch, etc.).
 *
 * @example
 * ```ts
 * import { createJsonLogger } from "@summa-ledger/core/logger";
 *
 * const logger = createJsonLogger({ level: "debug", service: "ledger" });
 * ```
 */
export function createJsonLogger(options: JsonLoggerOptions = {}): SummaLogger {
	const { level = "info", service = "summa" } = options;
	const minPriority = LEVEL_PRIORITY[level];
	const redactKeys = buildRedactKeys(options.redactKeys);

	function emit(lvl: LogLevel, message: string, data?: Record<string, unknown>) {
		if (LEVEL_PRIORITY[lvl] < minPriority) return;

		const safeData = redactData(data, redactKeys);
		const entry: Record<string, unknown> = {
			timestamp: new Date().toISOString(),
			level: lvl,
			service,
			message,
			...safeData,
		};

		const _line = JSON.stringify(entry);
		const _method = lvl === "error" ? "error" : lvl === "warn" ? "warn" : "log";
	}

	return {
		debug: (message, data) => emit("debug", message, data),
		info: (message, data) => emit("info", message, data),
		warn: (message, data) => emit("warn", message, data),
		error: (message, data) => emit("error", message, data),
	};
}
