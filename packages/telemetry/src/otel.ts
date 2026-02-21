// =============================================================================
// OPENTELEMETRY INTEGRATION — Opt-in tracing and metrics for Summa
// =============================================================================
// Uses @opentelemetry/api as an optional peer dependency.
// If not installed, all exports return no-op implementations.

/** Minimal logger interface matching SummaLogger from @summa/core */
interface SummaLogger {
	debug(message: string, data?: Record<string, unknown>): void;
	info(message: string, data?: Record<string, unknown>): void;
	warn(message: string, data?: Record<string, unknown>): void;
	error(message: string, data?: Record<string, unknown>): void;
}

// =============================================================================
// TYPES
// =============================================================================

export interface SummaOtelOptions {
	/** Service name for OTEL spans. Default: "summa-ledger" */
	serviceName?: string;
	/** Whether OTEL tracing is enabled. Default: true (if @opentelemetry/api is available) */
	enabled?: boolean;
}

interface OtelApi {
	trace: {
		getTracer(name: string): Tracer;
	};
}

interface Tracer {
	startSpan(name: string, options?: Record<string, unknown>): Span;
}

interface Span {
	setAttribute(key: string, value: string | number | boolean): void;
	setStatus(status: { code: number; message?: string }): void;
	end(): void;
}

// =============================================================================
// OTEL API LOADER (optional peer dep)
// =============================================================================

let otelApi: OtelApi | null = null;
let otelLoadAttempted = false;
let otelLoadPromise: Promise<OtelApi | null> | null = null;

async function loadOtelApi(): Promise<OtelApi | null> {
	if (otelLoadAttempted) return otelApi;
	otelLoadAttempted = true;
	try {
		// Use a variable to prevent TypeScript from resolving the module at compile time.
		// @opentelemetry/api is an optional peer dependency.
		const moduleName = "@opentelemetry/api";
		otelApi = (await import(/* @vite-ignore */ moduleName)) as unknown as OtelApi;
	} catch {
		otelApi = null;
	}
	return otelApi;
}

function getOtelApi(): OtelApi | null {
	if (otelLoadAttempted) return otelApi;
	// Trigger async load; return null synchronously until loaded
	if (!otelLoadPromise) {
		otelLoadPromise = loadOtelApi();
	}
	return otelApi;
}

// =============================================================================
// NO-OP SPAN
// =============================================================================

const noopSpan: Span = {
	setAttribute: () => {},
	setStatus: () => {},
	end: () => {},
};

// =============================================================================
// TRACING LOGGER
// =============================================================================

/**
 * Create a SummaLogger that wraps an inner logger and also creates OTEL spans
 * for warn/error log entries (useful for correlating logs with traces).
 */
export function createOtelLogger(inner: SummaLogger, options?: SummaOtelOptions): SummaLogger {
	const serviceName = options?.serviceName ?? "summa-ledger";
	const enabled = options?.enabled ?? true;

	function getTracer(): Tracer | null {
		if (!enabled) return null;
		const api = getOtelApi();
		return api?.trace.getTracer(serviceName) ?? null;
	}

	return {
		debug: (message, data) => inner.debug(message, data),
		info: (message, data) => inner.info(message, data),
		warn: (message, data) => {
			inner.warn(message, data);
			const tracer = getTracer();
			if (tracer) {
				const span = tracer.startSpan(`log.warn: ${message}`);
				span.setAttribute("log.level", "warn");
				if (data) {
					for (const [k, v] of Object.entries(data)) {
						if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
							span.setAttribute(`log.${k}`, v);
						}
					}
				}
				span.end();
			}
		},
		error: (message, data) => {
			inner.error(message, data);
			const tracer = getTracer();
			if (tracer) {
				const span = tracer.startSpan(`log.error: ${message}`);
				span.setAttribute("log.level", "error");
				span.setStatus({ code: 2, message }); // SpanStatusCode.ERROR = 2
				if (data) {
					for (const [k, v] of Object.entries(data)) {
						if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
							span.setAttribute(`log.${k}`, v);
						}
					}
				}
				span.end();
			}
		},
	};
}

// =============================================================================
// REQUEST TRACING HOOK
// =============================================================================

/**
 * Create a tracing function that starts/ends a span around a request.
 * Designed to be used with the Summa API handler's onRequest/onResponse hooks.
 *
 * Returns `{ startSpan, endSpan }` — call `startSpan` at request start
 * and `endSpan` at request end.
 */
export function createRequestTracer(options?: SummaOtelOptions) {
	const serviceName = options?.serviceName ?? "summa-ledger";
	const enabled = options?.enabled ?? true;

	const activeSpans = new Map<string, { span: Span; timer: ReturnType<typeof setTimeout> }>();
	const SPAN_TTL_MS = 60_000; // Auto-end orphaned spans after 1 minute

	return {
		/**
		 * Start a trace span for a request. Returns the span (or no-op).
		 */
		startSpan(requestId: string, method: string, path: string): Span {
			if (!enabled) return noopSpan;
			const api = getOtelApi();
			if (!api) return noopSpan;

			const tracer = api.trace.getTracer(serviceName);
			const span = tracer.startSpan(`HTTP ${method} ${path}`);
			span.setAttribute("http.method", method);
			span.setAttribute("http.route", path);
			span.setAttribute("http.request_id", requestId);

			// Auto-cleanup orphaned spans (e.g., dropped connections)
			const timer = setTimeout(() => {
				const entry = activeSpans.get(requestId);
				if (entry) {
					entry.span.setAttribute("http.orphaned", true);
					entry.span.end();
					activeSpans.delete(requestId);
				}
			}, SPAN_TTL_MS);
			activeSpans.set(requestId, { span, timer });
			return span;
		},

		/**
		 * End a trace span for a request.
		 */
		endSpan(requestId: string, statusCode: number): void {
			const entry = activeSpans.get(requestId);
			if (!entry) return;
			clearTimeout(entry.timer);
			entry.span.setAttribute("http.status_code", statusCode);
			if (statusCode >= 500) {
				entry.span.setStatus({ code: 2, message: `HTTP ${statusCode}` });
			}
			entry.span.end();
			activeSpans.delete(requestId);
		},
	};
}
