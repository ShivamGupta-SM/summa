// =============================================================================
// API HANDLER — Framework-agnostic router for Summa ledger operations
// =============================================================================

import { randomUUID } from "node:crypto";
import type {
	AccountStatus,
	HolderType,
	LimitType,
	PluginApiRequest,
	PluginApiResponse,
	PluginEndpoint,
	SummaContext,
	TransactionStatus,
	TransactionType,
} from "@summa/core";
import { SummaError } from "@summa/core";
import { createTableResolver } from "@summa/core/db";
import type { Summa } from "../summa/base.js";
import type { RateLimiter, RateLimitResult } from "./rate-limiter.js";

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
// ROUTE HELPERS
// =============================================================================

type MatchedRouteHandler = (
	req: ApiRequest,
	summa: Summa,
	params: Record<string, string>,
) => Promise<ApiResponse>;

interface Route {
	method: string;
	pattern: RegExp;
	paramNames: string[];
	handler: MatchedRouteHandler;
}

function defineRoute(method: string, path: string, handler: MatchedRouteHandler): Route {
	const paramNames: string[] = [];
	const patternStr = path.replace(/:(\w+)/g, (_, name: string) => {
		paramNames.push(name);
		return "([^/]+)";
	});
	return { method, pattern: new RegExp(`^${patternStr}$`), paramNames, handler };
}

function matchRoute(route: Route, path: string): Record<string, string> | null {
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

function json(status: number, body: unknown): ApiResponse {
	return { status, body, headers: { "Content-Type": "application/json" } };
}

// =============================================================================
// REQUEST BODY VALIDATION
// =============================================================================

type FieldSpec =
	| "string"
	| "number"
	| "boolean"
	| "object"
	| "string?"
	| "number?"
	| "boolean?"
	| "object?";

function validateBody(body: unknown, fields: Record<string, FieldSpec>): { error: string } | null {
	if (body === null || body === undefined || typeof body !== "object") {
		return { error: "Request body must be a JSON object" };
	}
	const obj = body as Record<string, unknown>;
	for (const [key, spec] of Object.entries(fields)) {
		const optional = spec.endsWith("?");
		const expectedType = optional ? spec.slice(0, -1) : spec;
		const value = obj[key];
		if (value === undefined || value === null) {
			if (!optional) return { error: `Missing required field: "${key}"` };
			continue;
		}
		if (expectedType === "array") {
			if (!Array.isArray(value)) {
				return { error: `Field "${key}" must be an array, got ${typeof value}` };
			}
		} else if (typeof value !== expectedType) {
			return { error: `Field "${key}" must be ${expectedType}, got ${typeof value}` };
		}
	}
	return null;
}

function validatePositiveIntegerAmount(body: unknown): { error: string } | null {
	const obj = body as Record<string, unknown>;
	const amount = obj.amount;
	if (typeof amount === "number") {
		if (!Number.isFinite(amount) || amount <= 0 || !Number.isInteger(amount)) {
			return { error: "amount must be a positive integer (in smallest currency units)" };
		}
	}
	return null;
}

// =============================================================================
// ENUM VALIDATION SETS
// =============================================================================

const VALID_ACCOUNT_STATUSES: ReadonlySet<string> = new Set(["active", "frozen", "closed"]);
const VALID_HOLDER_TYPES: ReadonlySet<string> = new Set(["individual", "organization", "system"]);
const VALID_TX_STATUSES: ReadonlySet<string> = new Set([
	"pending",
	"inflight",
	"posted",
	"expired",
	"voided",
	"reversed",
]);
const VALID_TX_TYPES: ReadonlySet<string> = new Set([
	"credit",
	"debit",
	"transfer",
	"journal",
	"correction",
	"adjustment",
]);
const VALID_HOLD_STATUSES: ReadonlySet<string> = new Set([
	"inflight",
	"posted",
	"voided",
	"expired",
]);
const VALID_TXN_TYPES: ReadonlySet<string> = new Set(["credit", "debit", "hold"]);

function validateEnum(
	value: string | undefined,
	validSet: ReadonlySet<string>,
	label: string,
): PluginApiResponse | null {
	if (value && !validSet.has(value)) {
		return json(400, {
			error: {
				code: "INVALID_ARGUMENT",
				message: `Invalid ${label}: "${value}". Must be one of: ${[...validSet].join(", ")}`,
			},
		});
	}
	return null;
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
	// No Origin header = server-to-server call, allow
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
// CORE ROUTES
// =============================================================================
// Route ordering matters: specific paths MUST come before parametric paths.
// e.g., /holds/active before /holds/:id

const routes: Route[] = [
	// --- Health Check ---
	defineRoute("GET", "/ok", async () => {
		return json(200, { ok: true });
	}),

	// --- Deep Health Check ---
	defineRoute("GET", "/health", async (_req, summa) => {
		const ctx = await summa.$context;
		const t = createTableResolver(ctx.options.schema);
		const checks: Record<string, unknown> = {};
		let healthy = true;

		// DB connectivity
		try {
			await ctx.adapter.raw<{ ok: number }>("SELECT 1 AS ok", []);
			checks.database = { status: "ok" };
		} catch (err) {
			checks.database = { status: "error", message: String(err) };
			healthy = false;
		}

		// Schema accessible
		try {
			const rows = await ctx.adapter.raw<{ cnt: string }>(
				`SELECT COUNT(*) as cnt FROM ${t("worker_lease")}`,
				[],
			);
			checks.schema = { status: "ok", workerLeases: Number(rows[0]?.cnt ?? 0) };
		} catch (err) {
			checks.schema = { status: "error", message: String(err) };
			healthy = false;
		}

		return json(healthy ? 200 : 503, {
			status: healthy ? "healthy" : "degraded",
			checks,
			timestamp: new Date().toISOString(),
		});
	}),

	// --- Accounts ---
	defineRoute("GET", "/accounts", async (req, summa) => {
		const statusErr = validateEnum(req.query.status, VALID_ACCOUNT_STATUSES, "status");
		if (statusErr) return statusErr;
		const holderTypeErr = validateEnum(req.query.holderType, VALID_HOLDER_TYPES, "holderType");
		if (holderTypeErr) return holderTypeErr;
		const result = await summa.accounts.list({
			page: req.query.page ? Number(req.query.page) : undefined,
			perPage: req.query.perPage ? Number(req.query.perPage) : undefined,
			status: req.query.status as AccountStatus | undefined,
			holderType: req.query.holderType as HolderType | undefined,
			search: req.query.search,
		});
		return json(200, result);
	}),
	defineRoute("POST", "/accounts", async (req, summa) => {
		const err = validateBody(req.body, {
			holderId: "string",
			holderType: "string",
			currency: "string?",
		});
		if (err) return json(400, { error: { code: "INVALID_ARGUMENT", message: err.error } });
		const { holderType } = req.body as { holderType: string };
		const holderTypeErr = validateEnum(holderType, VALID_HOLDER_TYPES, "holderType");
		if (holderTypeErr) return holderTypeErr;
		const result = await summa.accounts.create(
			req.body as Parameters<Summa["accounts"]["create"]>[0],
		);
		return json(201, result);
	}),
	defineRoute("GET", "/accounts/:holderId/balance", async (_req, summa, params) => {
		const result = await summa.accounts.getBalance(params.holderId ?? "");
		return json(200, result);
	}),
	defineRoute("POST", "/accounts/:holderId/freeze", async (req, summa, params) => {
		const err = validateBody(req.body, { reason: "string", frozenBy: "string" });
		if (err) return json(400, { error: { code: "INVALID_ARGUMENT", message: err.error } });
		const body = req.body as { reason: string; frozenBy: string };
		const result = await summa.accounts.freeze({ ...body, holderId: params.holderId ?? "" });
		return json(200, result);
	}),
	defineRoute("POST", "/accounts/:holderId/unfreeze", async (req, summa, params) => {
		const err = validateBody(req.body, { unfrozenBy: "string", reason: "string?" });
		if (err) return json(400, { error: { code: "INVALID_ARGUMENT", message: err.error } });
		const body = req.body as { unfrozenBy: string; reason?: string };
		const result = await summa.accounts.unfreeze({ ...body, holderId: params.holderId ?? "" });
		return json(200, result);
	}),
	defineRoute("POST", "/accounts/:holderId/close", async (req, summa, params) => {
		const err = validateBody(req.body, {
			closedBy: "string",
			reason: "string?",
			transferToHolderId: "string?",
		});
		if (err) return json(400, { error: { code: "INVALID_ARGUMENT", message: err.error } });
		const body = req.body as { closedBy: string; reason?: string; transferToHolderId?: string };
		const result = await summa.accounts.close({ ...body, holderId: params.holderId ?? "" });
		return json(200, result);
	}),
	defineRoute("GET", "/accounts/:holderId", async (_req, summa, params) => {
		const result = await summa.accounts.get(params.holderId ?? "");
		return json(200, result);
	}),

	// --- Chart of Accounts ---
	defineRoute("GET", "/chart-of-accounts/by-type", async (req, summa) => {
		const accountType = req.query.accountType;
		if (!accountType) {
			return json(400, {
				error: { code: "INVALID_ARGUMENT", message: 'Missing required query param: "accountType"' },
			});
		}
		const result = await summa.chartOfAccounts.getByType(
			accountType as Parameters<Summa["chartOfAccounts"]["getByType"]>[0],
		);
		return json(200, result);
	}),
	defineRoute("GET", "/chart-of-accounts/hierarchy", async (req, summa) => {
		const result = await summa.chartOfAccounts.getHierarchy(req.query.rootAccountId);
		return json(200, result);
	}),
	defineRoute("GET", "/chart-of-accounts/validate", async (_req, summa) => {
		const result = await summa.chartOfAccounts.validateEquation();
		return json(200, result);
	}),
	defineRoute("GET", "/chart-of-accounts/:accountId/children", async (_req, summa, params) => {
		const result = await summa.chartOfAccounts.getChildren(params.accountId ?? "");
		return json(200, result);
	}),

	// --- Transactions ---
	defineRoute("GET", "/transactions", async (req, summa) => {
		const statusErr = validateEnum(req.query.status, VALID_TX_STATUSES, "status");
		if (statusErr) return statusErr;
		const typeErr = validateEnum(req.query.type, VALID_TX_TYPES, "type");
		if (typeErr) return typeErr;
		const result = await summa.transactions.list({
			holderId: req.query.holderId ?? "",
			page: req.query.page ? Number(req.query.page) : undefined,
			perPage: req.query.perPage ? Number(req.query.perPage) : undefined,
			status: req.query.status as TransactionStatus | undefined,
			category: req.query.category,
			type: req.query.type as TransactionType | undefined,
			dateFrom: req.query.dateFrom,
			dateTo: req.query.dateTo,
			amountMin: req.query.amountMin ? Number(req.query.amountMin) : undefined,
			amountMax: req.query.amountMax ? Number(req.query.amountMax) : undefined,
		});
		return json(200, result);
	}),
	defineRoute("POST", "/transactions/credit", async (req, summa) => {
		const err = validateBody(req.body, {
			holderId: "string",
			amount: "number",
			reference: "string",
			description: "string?",
			category: "string?",
			sourceSystemAccount: "string?",
			idempotencyKey: "string?",
		});
		if (err) return json(400, { error: { code: "INVALID_ARGUMENT", message: err.error } });
		const amtErr = validatePositiveIntegerAmount(req.body);
		if (amtErr) return json(400, { error: { code: "INVALID_ARGUMENT", message: amtErr.error } });
		const result = await summa.transactions.credit(
			req.body as Parameters<Summa["transactions"]["credit"]>[0],
		);
		return json(201, result);
	}),
	defineRoute("POST", "/transactions/debit", async (req, summa) => {
		const err = validateBody(req.body, {
			holderId: "string",
			amount: "number",
			reference: "string",
			description: "string?",
			category: "string?",
			destinationSystemAccount: "string?",
			allowOverdraft: "boolean?",
			idempotencyKey: "string?",
		});
		if (err) return json(400, { error: { code: "INVALID_ARGUMENT", message: err.error } });
		const amtErr = validatePositiveIntegerAmount(req.body);
		if (amtErr) return json(400, { error: { code: "INVALID_ARGUMENT", message: amtErr.error } });
		const result = await summa.transactions.debit(
			req.body as Parameters<Summa["transactions"]["debit"]>[0],
		);
		return json(201, result);
	}),
	defineRoute("POST", "/transactions/transfer", async (req, summa) => {
		const err = validateBody(req.body, {
			sourceHolderId: "string",
			destinationHolderId: "string",
			amount: "number",
			reference: "string",
			description: "string?",
			category: "string?",
			exchangeRate: "number?",
			idempotencyKey: "string?",
		});
		if (err) return json(400, { error: { code: "INVALID_ARGUMENT", message: err.error } });
		const amtErr = validatePositiveIntegerAmount(req.body);
		if (amtErr) return json(400, { error: { code: "INVALID_ARGUMENT", message: amtErr.error } });
		const result = await summa.transactions.transfer(
			req.body as Parameters<Summa["transactions"]["transfer"]>[0],
		);
		return json(201, result);
	}),
	defineRoute("POST", "/transactions/multi-transfer", async (req, summa) => {
		const err = validateBody(req.body, {
			sourceHolderId: "string",
			amount: "number",
			destinations: "object",
			reference: "string",
			description: "string?",
			category: "string?",
			idempotencyKey: "string?",
		});
		if (err) return json(400, { error: { code: "INVALID_ARGUMENT", message: err.error } });
		const amtErr = validatePositiveIntegerAmount(req.body);
		if (amtErr) return json(400, { error: { code: "INVALID_ARGUMENT", message: amtErr.error } });
		const result = await summa.transactions.multiTransfer(
			req.body as Parameters<Summa["transactions"]["multiTransfer"]>[0],
		);
		return json(201, result);
	}),
	defineRoute("POST", "/transactions/refund", async (req, summa) => {
		const err = validateBody(req.body, {
			transactionId: "string",
			reason: "string",
			amount: "number?",
			idempotencyKey: "string?",
		});
		if (err) return json(400, { error: { code: "INVALID_ARGUMENT", message: err.error } });
		const result = await summa.transactions.refund(
			req.body as Parameters<Summa["transactions"]["refund"]>[0],
		);
		return json(201, result);
	}),
	defineRoute("POST", "/transactions/correct", async (req, summa) => {
		const err = validateBody(req.body, {
			transactionId: "string",
			correctionEntries: "object",
			reason: "string",
		});
		if (err) return json(400, { error: { code: "INVALID_ARGUMENT", message: err.error } });
		const result = await summa.transactions.correct(
			req.body as Parameters<Summa["transactions"]["correct"]>[0],
		);
		return json(201, result);
	}),
	defineRoute("POST", "/transactions/adjust", async (req, summa) => {
		const err = validateBody(req.body, {
			entries: "object",
			reference: "string",
			adjustmentType: "string",
		});
		if (err) return json(400, { error: { code: "INVALID_ARGUMENT", message: err.error } });
		const VALID_ADJUSTMENT_TYPES: ReadonlySet<string> = new Set([
			"accrual",
			"depreciation",
			"correction",
			"reclassification",
		]);
		const { adjustmentType } = req.body as { adjustmentType: string };
		if (!VALID_ADJUSTMENT_TYPES.has(adjustmentType)) {
			return json(400, {
				error: {
					code: "INVALID_ARGUMENT",
					message: `Invalid adjustmentType: "${adjustmentType}". Must be one of: accrual, depreciation, correction, reclassification`,
				},
			});
		}
		const result = await summa.transactions.adjust(
			req.body as Parameters<Summa["transactions"]["adjust"]>[0],
		);
		return json(201, result);
	}),
	defineRoute("POST", "/transactions/journal", async (req, summa) => {
		const err = validateBody(req.body, {
			entries: "object",
			reference: "string",
		});
		if (err) return json(400, { error: { code: "INVALID_ARGUMENT", message: err.error } });
		const result = await summa.transactions.journal(
			req.body as Parameters<Summa["transactions"]["journal"]>[0],
		);
		return json(201, result);
	}),
	defineRoute("GET", "/transactions/:id", async (_req, summa, params) => {
		const result = await summa.transactions.get(params.id ?? "");
		return json(200, result);
	}),

	// --- Holds ---
	// Specific paths before parametric
	defineRoute("GET", "/holds/active", async (req, summa) => {
		const result = await summa.holds.listActive({
			holderId: req.query.holderId ?? "",
			page: req.query.page ? Number(req.query.page) : undefined,
			perPage: req.query.perPage ? Number(req.query.perPage) : undefined,
			category: req.query.category,
		});
		return json(200, result);
	}),
	defineRoute("GET", "/holds", async (req, summa) => {
		const statusErr = validateEnum(req.query.status, VALID_HOLD_STATUSES, "status");
		if (statusErr) return statusErr;
		const result = await summa.holds.listAll({
			holderId: req.query.holderId ?? "",
			page: req.query.page ? Number(req.query.page) : undefined,
			perPage: req.query.perPage ? Number(req.query.perPage) : undefined,
			status: req.query.status as "inflight" | "posted" | "voided" | "expired" | undefined,
			category: req.query.category,
		});
		return json(200, result);
	}),
	defineRoute("POST", "/holds", async (req, summa) => {
		const err = validateBody(req.body, {
			holderId: "string",
			amount: "number",
			reference: "string",
			description: "string?",
			category: "string?",
			destinationHolderId: "string?",
			destinationSystemAccount: "string?",
			expiresInMinutes: "number?",
			idempotencyKey: "string?",
		});
		if (err) return json(400, { error: { code: "INVALID_ARGUMENT", message: err.error } });
		const amtErr = validatePositiveIntegerAmount(req.body);
		if (amtErr) return json(400, { error: { code: "INVALID_ARGUMENT", message: amtErr.error } });
		const result = await summa.holds.create(req.body as Parameters<Summa["holds"]["create"]>[0]);
		return json(201, result);
	}),
	defineRoute("POST", "/holds/multi-destination", async (req, summa) => {
		const err = validateBody(req.body, {
			holderId: "string",
			amount: "number",
			reference: "string",
			description: "string?",
			category: "string?",
			destinations: "object",
			expiresInMinutes: "number?",
			idempotencyKey: "string?",
		});
		if (err) return json(400, { error: { code: "INVALID_ARGUMENT", message: err.error } });
		const amtErr = validatePositiveIntegerAmount(req.body);
		if (amtErr) return json(400, { error: { code: "INVALID_ARGUMENT", message: amtErr.error } });
		const result = await summa.holds.createMultiDestination(
			req.body as Parameters<Summa["holds"]["createMultiDestination"]>[0],
		);
		return json(201, result);
	}),
	defineRoute("POST", "/holds/:holdId/commit", async (req, summa, params) => {
		const err = validateBody(req.body, { amount: "number?" });
		if (err) return json(400, { error: { code: "INVALID_ARGUMENT", message: err.error } });
		const body = req.body as { amount?: number };
		const result = await summa.holds.commit({ ...body, holdId: params.holdId ?? "" });
		return json(200, result);
	}),
	defineRoute("POST", "/holds/:holdId/void", async (req, summa, params) => {
		const err = validateBody(req.body, { reason: "string?" });
		if (err) return json(400, { error: { code: "INVALID_ARGUMENT", message: err.error } });
		const body = req.body as { reason?: string };
		const result = await summa.holds.void({ ...body, holdId: params.holdId ?? "" });
		return json(200, result);
	}),
	defineRoute("GET", "/holds/:id", async (_req, summa, params) => {
		const result = await summa.holds.get(params.id ?? "");
		return json(200, result);
	}),

	// --- Limits ---
	defineRoute("POST", "/limits", async (req, summa) => {
		const err = validateBody(req.body, {
			holderId: "string",
			limitType: "string",
			maxAmount: "number",
		});
		if (err) return json(400, { error: { code: "INVALID_ARGUMENT", message: err.error } });
		const VALID_LIMIT_TYPES = new Set(["per_transaction", "daily", "monthly"]);
		const { limitType } = req.body as { limitType: string };
		if (!VALID_LIMIT_TYPES.has(limitType)) {
			return json(400, {
				error: {
					code: "INVALID_ARGUMENT",
					message: `Invalid limitType: "${limitType}". Must be one of: per_transaction, daily, monthly`,
				},
			});
		}
		const result = await summa.limits.set(req.body as Parameters<Summa["limits"]["set"]>[0]);
		return json(201, result);
	}),
	defineRoute("GET", "/limits/:holderId/usage", async (req, summa, params) => {
		const txnTypeErr = validateEnum(req.query.txnType, VALID_TXN_TYPES, "txnType");
		if (txnTypeErr) return txnTypeErr;
		const result = await summa.limits.getUsage({
			holderId: params.holderId ?? "",
			txnType: req.query.txnType as "credit" | "debit" | "hold" | undefined,
			category: req.query.category,
		});
		return json(200, result);
	}),
	defineRoute("GET", "/limits/:holderId", async (_req, summa, params) => {
		const result = await summa.limits.get(params.holderId ?? "");
		return json(200, result);
	}),
	defineRoute("DELETE", "/limits/:holderId", async (req, summa, params) => {
		const err = validateBody(req.body, { limitType: "string", category: "string?" });
		if (err) return json(400, { error: { code: "INVALID_ARGUMENT", message: err.error } });
		const body = req.body as { limitType: LimitType; category?: string };
		await summa.limits.remove({
			...body,
			holderId: params.holderId ?? "",
		});
		return json(204, null);
	}),

	// --- Events ---
	// Specific path before parametric
	defineRoute("GET", "/events/correlation/:correlationId", async (_req, summa, params) => {
		const result = await summa.events.getByCorrelation(params.correlationId ?? "");
		return json(200, result);
	}),
	defineRoute("POST", "/events/verify", async (req, summa) => {
		const err = validateBody(req.body, { aggregateType: "string", aggregateId: "string" });
		if (err) return json(400, { error: { code: "INVALID_ARGUMENT", message: err.error } });
		const body = req.body as { aggregateType: string; aggregateId: string };
		const result = await summa.events.verifyChain(body.aggregateType, body.aggregateId);
		return json(200, result);
	}),
	defineRoute("GET", "/events/:aggregateType/:aggregateId", async (_req, summa, params) => {
		const result = await summa.events.getForAggregate(
			params.aggregateType ?? "",
			params.aggregateId ?? "",
		);
		return json(200, result);
	}),
];

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

	// Inject per-request context for actor tracking / audit trail
	ctx.requestContext = {
		requestId: String(requestId),
		actor: currentReq.headers?.["x-actor-id"] ?? currentReq.headers?.["X-Actor-Id"],
	};

	const pluginReq = toPluginReq(currentReq);
	for (const plugin of ctx.plugins) {
		if (!plugin.onRequest) continue;
		const hookResult = await plugin.onRequest(pluginReq);
		if ("status" in hookResult && "body" in hookResult) {
			// Plugin short-circuited with a response
			return withHeaders({
				status: (hookResult as PluginApiResponse).status,
				body: (hookResult as PluginApiResponse).body,
				headers: {
					"Content-Type": "application/json",
					...(hookResult as PluginApiResponse).headers,
				},
			});
		}
		// Plugin transformed the request — update for downstream
		Object.assign(pluginReq, hookResult);
	}

	// --- Plugin-level rate limiting ---
	// Plugins can declare per-operation rate limits via `rateLimit` field.
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
