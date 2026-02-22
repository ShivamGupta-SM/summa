// =============================================================================
// API HANDLER — Framework-agnostic router for Summa ledger operations
// =============================================================================

import { randomUUID } from "node:crypto";
import type {
	PluginApiRequest,
	PluginApiResponse,
	PluginEndpoint,
	SummaContext,
} from "@summa/core";
import { SummaError } from "@summa/core";
import type { Summa } from "../summa/base.js";
import type { RateLimiter, RateLimitResult } from "./rate-limiter.js";
import { routes } from "./routes/index.js";

// =============================================================================
// TYPES
// =============================================================================

export interface ApiRequest {
	method: string;
	path: string;
	body: unknown;
	query: Record<string, string | undefined>;
	headers?: Record<string, string>;
}

export interface ApiResponse {
	status: number;
	body: unknown;
	headers?: Record<string, string>;
}

export interface ApiHandlerOptions {
	/** Rate limiter instance */
	rateLimiter?: RateLimiter;
	/** Function to extract rate limit key from request (e.g., IP, API key). Default: "global" */
	rateLimitKeyExtractor?: (req: ApiRequest) => string;
	/** Trusted origins for CSRF protection. If set, state-mutating requests require valid Origin header. */
	trustedOrigins?: string[];
	/** Request interceptor. Return an ApiResponse to short-circuit (e.g., 401 for auth). */
	onRequest?: (req: ApiRequest) => ApiRequest | ApiResponse | Promise<ApiRequest | ApiResponse>;
	/** Response interceptor. Runs after route handler. */
	onResponse?: (req: ApiRequest, res: ApiResponse) => ApiResponse | Promise<ApiResponse>;
}

// =============================================================================
// ROUTE HELPERS (exported for use by domain route files)
// =============================================================================

export type MatchedRouteHandler = (
	req: ApiRequest,
	summa: Summa,
	params: Record<string, string>,
) => Promise<ApiResponse>;

export interface Route {
	method: string;
	pattern: RegExp;
	paramNames: string[];
	handler: MatchedRouteHandler;
}

export function defineRoute(method: string, path: string, handler: MatchedRouteHandler): Route {
	const paramNames: string[] = [];
	const patternStr = path.replace(/:(\w+)/g, (_, name: string) => {
		paramNames.push(name);
		return "([^/]+)";
	});
	return { method, pattern: new RegExp(`^${patternStr}$`), paramNames, handler };
}

export function matchRoute(route: Route, path: string): Record<string, string> | null {
	const match = route.pattern.exec(path);
	if (!match) return null;
	const params: Record<string, string> = {};
	for (let i = 0; i < route.paramNames.length; i++) {
		const name = route.paramNames[i];
		const value = match[i + 1];
		if (name && value) params[name] = value;
	}
	return params;
}

export function json(status: number, body: unknown): ApiResponse {
	return { status, body, headers: { "Content-Type": "application/json" } };
}

// =============================================================================
// RATE LIMIT HEADERS
// =============================================================================

function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
	const headers: Record<string, string> = {
		"X-RateLimit-Limit": String(result.limit),
		"X-RateLimit-Remaining": String(result.remaining),
		"X-RateLimit-Reset": String(Math.ceil(result.resetAt.getTime() / 1000)),
	};
	if (!result.allowed) {
		const retryAfter = Math.max(0, Math.ceil((result.resetAt.getTime() - Date.now()) / 1000));
		headers["Retry-After"] = String(retryAfter);
	}
	return headers;
}

// =============================================================================
// CSRF / ORIGIN CHECK
// =============================================================================

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function checkOrigin(req: ApiRequest, trustedOrigins: string[]): boolean {
	const origin = req.headers?.origin ?? req.headers?.Origin;
	if (!origin) return true;
	return trustedOrigins.some((trusted) => {
		try {
			return origin === trusted || origin === new URL(trusted).origin;
		} catch {
			return origin === trusted;
		}
	});
}

// =============================================================================
// PLUGIN ROUTE COMPILATION (lazy)
// =============================================================================

interface CompiledPluginRoute {
	method: string;
	pattern: RegExp;
	paramNames: string[];
	endpoint: PluginEndpoint;
}

const compiledPluginRoutesCache = new WeakMap<SummaContext, CompiledPluginRoute[]>();

function compilePluginRoutes(ctx: SummaContext): CompiledPluginRoute[] {
	const compiled: CompiledPluginRoute[] = [];
	for (const plugin of ctx.plugins) {
		if (!plugin.endpoints) continue;
		for (const endpoint of plugin.endpoints) {
			const paramNames: string[] = [];
			const patternStr = endpoint.path.replace(/:(\w+)/g, (_, name: string) => {
				paramNames.push(name);
				return "([^/]+)";
			});
			compiled.push({
				method: endpoint.method,
				pattern: new RegExp(`^${patternStr}$`),
				paramNames,
				endpoint,
			});
		}
	}
	return compiled;
}

function getPluginRoutes(ctx: SummaContext): CompiledPluginRoute[] {
	let cached = compiledPluginRoutesCache.get(ctx);
	if (!cached) {
		cached = compilePluginRoutes(ctx);
		compiledPluginRoutesCache.set(ctx, cached);
	}
	return cached;
}

function matchCompiledRoute(
	route: CompiledPluginRoute,
	path: string,
): Record<string, string> | null {
	const match = route.pattern.exec(path);
	if (!match) return null;
	const params: Record<string, string> = {};
	for (let i = 0; i < route.paramNames.length; i++) {
		const name = route.paramNames[i];
		const value = match[i + 1];
		if (name && value) params[name] = value;
	}
	return params;
}

// =============================================================================
// MAIN HANDLER
// =============================================================================

/**
 * Handle an incoming API request against the Summa ledger.
 */
export async function handleRequest(
	summa: Summa,
	req: ApiRequest,
	options?: ApiHandlerOptions,
): Promise<ApiResponse> {
	let currentReq = req;

	// --- Request ID ---
	const requestId =
		currentReq.headers?.["x-request-id"] ?? currentReq.headers?.["X-Request-Id"] ?? randomUUID();

	// --- Global onRequest hook ---
	if (options?.onRequest) {
		const result = await options.onRequest(currentReq);
		if ("status" in result && "body" in result) {
			return result as ApiResponse;
		}
		currentReq = result as ApiRequest;
	}

	const method = currentReq.method.toUpperCase();

	// --- CSRF / Origin protection ---
	if (options?.trustedOrigins && MUTATING_METHODS.has(method)) {
		if (!checkOrigin(currentReq, options.trustedOrigins)) {
			return json(403, {
				error: { code: "FORBIDDEN", message: "Origin not allowed" },
			});
		}
	}

	// --- Rate limiting ---
	let rlHeaders: Record<string, string> | undefined;
	if (options?.rateLimiter) {
		const key = options.rateLimitKeyExtractor?.(currentReq) ?? "global";
		const result = await options.rateLimiter.consume(key);
		rlHeaders = rateLimitHeaders(result);

		if (!result.allowed) {
			return {
				status: 429,
				body: { error: { code: "RATE_LIMITED", message: "Too many requests" } },
				headers: { "Content-Type": "application/json", ...rlHeaders },
			};
		}
	}

	// Security headers applied to every response
	const securityHeaders: Record<string, string> = {
		"X-Content-Type-Options": "nosniff",
		"X-Frame-Options": "DENY",
		"Referrer-Policy": "strict-origin-when-cross-origin",
		"X-XSS-Protection": "0",
		"Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
	};

	// Helper to merge security + rate limit + request ID headers into response
	const withHeaders = (response: ApiResponse): ApiResponse => {
		response.headers = {
			...securityHeaders,
			...response.headers,
			...rlHeaders,
			"X-Request-Id": requestId,
		};
		return response;
	};

	// --- Plugin onRequest hooks ---
	const ctx = await summa.$context;

	// Extract ledgerId from request body or X-Ledger-Id header
	const bodyLedgerId =
		currentReq.body && typeof currentReq.body === "object"
			? (currentReq.body as Record<string, unknown>).ledgerId
			: undefined;
	const headerLedgerId = currentReq.headers?.["x-ledger-id"] ?? currentReq.headers?.["X-Ledger-Id"];
	const requestLedgerId = (bodyLedgerId ?? headerLedgerId ?? undefined) as string | undefined;

	// Set ledgerId on context for downstream managers
	if (requestLedgerId) {
		ctx.ledgerId = requestLedgerId;
	}

	// Inject per-request context for actor tracking / audit trail
	ctx.requestContext = {
		requestId: String(requestId),
		ledgerId: requestLedgerId ?? ctx.ledgerId ?? "",
		actor: currentReq.headers?.["x-actor-id"] ?? currentReq.headers?.["X-Actor-Id"],
	};

	const pluginReq = toPluginReq(currentReq);
	for (const plugin of ctx.plugins) {
		if (!plugin.onRequest) continue;
		const hookResult = await plugin.onRequest(pluginReq);
		if ("status" in hookResult && "body" in hookResult) {
			return withHeaders({
				status: (hookResult as PluginApiResponse).status,
				body: (hookResult as PluginApiResponse).body,
				headers: {
					"Content-Type": "application/json",
					...(hookResult as PluginApiResponse).headers,
				},
			});
		}
		Object.assign(pluginReq, hookResult);
	}

	// --- Plugin-level rate limiting ---
	if (options?.rateLimiter) {
		const operation = `${method}:${currentReq.path}`;
		for (const plugin of ctx.plugins) {
			if (!plugin.rateLimit) continue;
			for (const rule of plugin.rateLimit) {
				const matches =
					typeof rule.operation === "function"
						? rule.operation(operation)
						: operation.includes(rule.operation);
				if (!matches) continue;
				const pluginKey = `plugin:${plugin.id}:${options.rateLimitKeyExtractor?.(currentReq) ?? "global"}`;
				const pluginResult = await options.rateLimiter.consume(pluginKey);
				if (!pluginResult.allowed) {
					return withHeaders({
						status: 429,
						body: {
							error: { code: "RATE_LIMITED", message: `Rate limited by ${plugin.id} plugin` },
						},
						headers: { "Content-Type": "application/json", ...rateLimitHeaders(pluginResult) },
					});
				}
			}
		}
	}

	// --- Route dispatch helper (shared error handling) ---
	const dispatch = async (): Promise<ApiResponse> => {
		// --- Core routes ---
		for (const r of routes) {
			if (method !== r.method) continue;
			const params = matchRoute(r, currentReq.path);
			if (!params) continue;
			return await r.handler(currentReq, summa, params);
		}

		// --- Plugin-contributed endpoints ---
		const pluginRoutes = getPluginRoutes(ctx);
		for (const pr of pluginRoutes) {
			if (method !== pr.method) continue;
			const params = matchCompiledRoute(pr, currentReq.path);
			if (!params) continue;
			const result = await pr.endpoint.handler({ ...pluginReq, params }, ctx);
			return {
				status: result.status,
				body: result.body,
				headers: { "Content-Type": "application/json", ...result.headers },
			};
		}

		return json(404, { error: { code: "NOT_FOUND", message: "Route not found" } });
	};

	let response: ApiResponse;
	try {
		response = await dispatch();
	} catch (error) {
		if (error instanceof SummaError) {
			response = json(error.status, {
				error: { code: error.code, message: error.message, docs: error.docsUrl },
			});
		} else {
			response = json(500, {
				error: {
					code: "INTERNAL",
					message: "Internal server error",
					docs: `${SummaError.docsBaseUrl}#internal`,
				},
			});
		}
	}

	// --- Plugin onResponse hooks (reverse order — middleware stack unwinding) ---
	for (let i = ctx.plugins.length - 1; i >= 0; i--) {
		const plugin = ctx.plugins[i];
		if (!plugin?.onResponse) continue;
		const pluginRes = await plugin.onResponse(pluginReq, {
			status: response.status,
			body: response.body,
			headers: response.headers,
		});
		response = {
			status: pluginRes.status,
			body: pluginRes.body,
			headers: { ...response.headers, ...pluginRes.headers },
		};
	}

	// --- Global onResponse hook ---
	if (options?.onResponse) {
		response = await options.onResponse(currentReq, response);
	}

	// Clean up per-request context to prevent leaking between requests
	ctx.requestContext = undefined;

	return withHeaders(response);
}

// =============================================================================
// HELPERS
// =============================================================================

function toPluginReq(req: ApiRequest): PluginApiRequest {
	return {
		method: req.method,
		path: req.path,
		body: req.body,
		query: req.query,
		params: {},
		headers: req.headers,
	};
}
