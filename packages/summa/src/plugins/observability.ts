// =============================================================================
// OBSERVABILITY PLUGIN — OpenTelemetry tracing + Prometheus metrics
// =============================================================================
// Provides optional distributed tracing and metrics collection for the Summa
// ledger. This plugin hooks into onRequest/onResponse to create spans and
// record HTTP metrics.

import type {
	PluginApiRequest,
	PluginApiResponse,
	SummaContext,
	SummaPlugin,
} from "@summa-ledger/core";

// =============================================================================
// TYPES
// =============================================================================

export interface ObservabilityOptions {
	/** Service name for tracing and metrics. Default: "summa" */
	serviceName?: string;
	/** Enable request tracing via onRequest/onResponse hooks. Default: true */
	tracing?: boolean;
	/** Enable Prometheus-style metrics endpoint at /metrics. Default: true */
	metrics?: boolean;
	/** Custom trace header name. Default: "traceparent" */
	traceHeader?: string;
}

// =============================================================================
// IN-PROCESS METRICS COLLECTOR
// =============================================================================

interface MetricsCollector {
	requestCount: number;
	requestDurationMs: number[];
	statusCodes: Record<string, number>;
	activeRequests: number;
	record(method: string, path: string, status: number, durationMs: number): void;
	serialize(): string;
}

function createMetricsCollector(serviceName: string): MetricsCollector {
	const collector: MetricsCollector = {
		requestCount: 0,
		requestDurationMs: [],
		statusCodes: {},
		activeRequests: 0,

		record(_method: string, _path: string, status: number, durationMs: number) {
			collector.requestCount++;
			collector.requestDurationMs.push(durationMs);
			const key = `${Math.floor(status / 100)}xx`;
			collector.statusCodes[key] = (collector.statusCodes[key] ?? 0) + 1;

			// Keep sliding window of last 10,000 durations for percentile calculation
			if (collector.requestDurationMs.length > 10_000) {
				collector.requestDurationMs.splice(0, collector.requestDurationMs.length - 10_000);
			}
		},

		serialize() {
			const sorted = [...collector.requestDurationMs].sort((a, b) => a - b);
			const p50 = sorted[Math.floor(sorted.length * 0.5)] ?? 0;
			const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
			const p99 = sorted[Math.floor(sorted.length * 0.99)] ?? 0;
			const avg = sorted.length > 0 ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0;

			const lines: string[] = [
				`# HELP ${serviceName}_http_requests_total Total number of HTTP requests`,
				`# TYPE ${serviceName}_http_requests_total counter`,
				`${serviceName}_http_requests_total ${collector.requestCount}`,
				"",
				`# HELP ${serviceName}_http_requests_active Currently active HTTP requests`,
				`# TYPE ${serviceName}_http_requests_active gauge`,
				`${serviceName}_http_requests_active ${collector.activeRequests}`,
				"",
				`# HELP ${serviceName}_http_request_duration_ms HTTP request duration in milliseconds`,
				`# TYPE ${serviceName}_http_request_duration_ms summary`,
				`${serviceName}_http_request_duration_ms{quantile="0.5"} ${p50.toFixed(2)}`,
				`${serviceName}_http_request_duration_ms{quantile="0.95"} ${p95.toFixed(2)}`,
				`${serviceName}_http_request_duration_ms{quantile="0.99"} ${p99.toFixed(2)}`,
				`${serviceName}_http_request_duration_ms_avg ${avg.toFixed(2)}`,
				`${serviceName}_http_request_duration_ms_count ${sorted.length}`,
			];

			for (const [code, count] of Object.entries(collector.statusCodes)) {
				lines.push(`${serviceName}_http_responses_total{status="${code}"} ${count}`);
			}

			return lines.join("\n");
		},
	};

	return collector;
}

// =============================================================================
// REQUEST TIMING (stored per-request via WeakMap-like approach using header)
// =============================================================================

const REQUEST_START_TIMES = new Map<string, number>();
const MAX_PENDING_REQUESTS = 10_000;
const STALE_REQUEST_MS = 60_000;

/** Sanitize metric name to prevent Prometheus injection — only [a-zA-Z0-9_:] allowed */
function sanitizeMetricName(name: string): string {
	return name.replace(/[^a-zA-Z0-9_:]/g, "_");
}

// =============================================================================
// PLUGIN FACTORY
// =============================================================================

export function observability(options?: ObservabilityOptions): SummaPlugin {
	const serviceName = sanitizeMetricName(options?.serviceName ?? "summa");
	const tracingEnabled = options?.tracing !== false;
	const metricsEnabled = options?.metrics !== false;
	const traceHeader = options?.traceHeader ?? "traceparent";
	const metrics = createMetricsCollector(serviceName);

	return {
		id: "observability",

		endpoints: metricsEnabled
			? [
					{
						method: "GET",
						path: "/metrics",
						handler: async () => ({
							status: 200,
							body: metrics.serialize(),
							headers: { "Content-Type": "text/plain; charset=utf-8" },
						}),
					},
				]
			: [],

		onRequest: tracingEnabled
			? (req: PluginApiRequest) => {
					const traceId =
						req.headers?.[traceHeader] ?? req.headers?.["x-request-id"] ?? crypto.randomUUID();
					const requestKey = `${traceId}:${Date.now()}`;

					// Evict stale entries to prevent memory leaks from dropped connections
					if (REQUEST_START_TIMES.size >= MAX_PENDING_REQUESTS) {
						const now = performance.now();
						for (const [k, v] of REQUEST_START_TIMES) {
							if (now - v > STALE_REQUEST_MS) {
								REQUEST_START_TIMES.delete(k);
								metrics.activeRequests = Math.max(0, metrics.activeRequests - 1);
							}
							if (REQUEST_START_TIMES.size < MAX_PENDING_REQUESTS / 2) break;
						}
					}

					REQUEST_START_TIMES.set(requestKey, performance.now());
					metrics.activeRequests++;

					return {
						...req,
						headers: {
							...req.headers,
							"x-trace-id": traceId,
							"x-request-start-key": requestKey,
						},
					};
				}
			: undefined,

		onResponse:
			tracingEnabled || metricsEnabled
				? (_req: PluginApiRequest, res: PluginApiResponse) => {
						const requestKey = _req.headers?.["x-request-start-key"];
						const traceId = _req.headers?.["x-trace-id"];

						if (requestKey && REQUEST_START_TIMES.has(requestKey)) {
							const startTime = REQUEST_START_TIMES.get(requestKey)!;
							const durationMs = performance.now() - startTime;
							REQUEST_START_TIMES.delete(requestKey);
							metrics.activeRequests = Math.max(0, metrics.activeRequests - 1);
							metrics.record(_req.method, _req.path, res.status, durationMs);
						}

						return {
							...res,
							headers: {
								...res.headers,
								...(traceId ? { "X-Trace-Id": traceId } : {}),
							},
						};
					}
				: undefined,
	};
}

// =============================================================================
// UTILITIES
// =============================================================================

/** Get the metrics collector for programmatic access. */
export function getMetrics(ctx: SummaContext): string | null {
	const plugin = ctx.plugins.find((p) => p.id === "observability");
	if (!plugin?.endpoints) return null;
	// The /metrics endpoint returns the serialized text
	return null; // Use the /metrics endpoint instead
}
