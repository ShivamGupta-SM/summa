// =============================================================================
// OPENAPI PLUGIN — Generates and serves OpenAPI 3.1 spec
// =============================================================================

import type { PluginEndpoint, SummaContext, SummaPlugin } from "@summa/core";

// =============================================================================
// TYPES
// =============================================================================

export interface OpenApiOptions {
	/** API title (default: "Summa Ledger API") */
	title?: string;
	/** API version (default: "0.1.0") */
	version?: string;
	/** API description */
	description?: string;
	/** Server URLs (default: []) */
	servers?: Array<{ url: string; description?: string }>;
}

// =============================================================================
// ROUTE METADATA (statically defined for core routes)
// =============================================================================

interface RouteInfo {
	method: string;
	path: string;
	summary: string;
	tag: string;
	requestBodySchema?: Record<string, unknown>;
	responseSchema?: Record<string, unknown>;
	responses: Record<string, { description: string; schema?: Record<string, unknown> }>;
}

const CORE_ROUTES: RouteInfo[] = [
	// Health
	{
		method: "get",
		path: "/ok",
		summary: "Health check",
		tag: "System",
		responses: { "200": { description: "OK" } },
	},

	// Accounts
	{
		method: "get",
		path: "/accounts",
		summary: "List accounts",
		tag: "Accounts",
		responses: { "200": { description: "Paginated list of accounts" } },
	},
	{
		method: "post",
		path: "/accounts",
		summary: "Create account",
		tag: "Accounts",
		requestBodySchema: {
			type: "object",
			required: ["holderId", "currency"],
			properties: {
				holderId: { type: "string", description: "Unique holder identifier" },
				currency: { type: "string", description: "ISO 4217 currency code" },
				holderType: {
					type: "string",
					enum: ["individual", "business"],
					description: "Type of account holder",
				},
				name: { type: "string", description: "Display name for the account" },
			},
		},
		responses: { "201": { description: "Account created" } },
	},
	{
		method: "get",
		path: "/accounts/{holderId}",
		summary: "Get account by holder ID",
		tag: "Accounts",
		responses: { "200": { description: "Account details" } },
	},
	{
		method: "get",
		path: "/accounts/{holderId}/balance",
		summary: "Get account balance",
		tag: "Accounts",
		responses: { "200": { description: "Account balance" } },
	},
	{
		method: "post",
		path: "/accounts/{holderId}/freeze",
		summary: "Freeze account",
		tag: "Accounts",
		responses: { "200": { description: "Account frozen" } },
	},
	{
		method: "post",
		path: "/accounts/{holderId}/unfreeze",
		summary: "Unfreeze account",
		tag: "Accounts",
		responses: { "200": { description: "Account unfrozen" } },
	},
	{
		method: "post",
		path: "/accounts/{holderId}/close",
		summary: "Close account",
		tag: "Accounts",
		responses: { "200": { description: "Account closed" } },
	},

	// Transactions
	{
		method: "get",
		path: "/transactions",
		summary: "List transactions",
		tag: "Transactions",
		responses: { "200": { description: "Paginated list of transactions" } },
	},
	{
		method: "post",
		path: "/transactions/credit",
		summary: "Credit account",
		tag: "Transactions",
		requestBodySchema: {
			type: "object",
			required: ["holderId", "amount", "currency"],
			properties: {
				holderId: { type: "string" },
				amount: { type: "number", description: "Amount in minor units (cents)" },
				currency: { type: "string" },
				description: { type: "string" },
				category: { type: "string" },
				metadata: { type: "object" },
				idempotencyKey: { type: "string" },
			},
		},
		responses: { "201": { description: "Credit transaction created" } },
	},
	{
		method: "post",
		path: "/transactions/debit",
		summary: "Debit account",
		tag: "Transactions",
		requestBodySchema: {
			type: "object",
			required: ["holderId", "amount", "currency"],
			properties: {
				holderId: { type: "string" },
				amount: { type: "number", description: "Amount in minor units (cents)" },
				currency: { type: "string" },
				description: { type: "string" },
				category: { type: "string" },
				metadata: { type: "object" },
				idempotencyKey: { type: "string" },
			},
		},
		responses: { "201": { description: "Debit transaction created" } },
	},
	{
		method: "post",
		path: "/transactions/transfer",
		summary: "Transfer between accounts",
		tag: "Transactions",
		requestBodySchema: {
			type: "object",
			required: ["fromHolderId", "toHolderId", "amount", "currency"],
			properties: {
				fromHolderId: { type: "string" },
				toHolderId: { type: "string" },
				amount: { type: "number", description: "Amount in minor units (cents)" },
				currency: { type: "string" },
				description: { type: "string" },
				category: { type: "string" },
				metadata: { type: "object" },
				idempotencyKey: { type: "string" },
			},
		},
		responses: { "201": { description: "Transfer transaction created" } },
	},
	{
		method: "post",
		path: "/transactions/multi-transfer",
		summary: "Multi-destination transfer",
		tag: "Transactions",
		requestBodySchema: {
			type: "object",
			required: ["entries", "currency"],
			properties: {
				entries: {
					type: "array",
					items: {
						type: "object",
						properties: {
							holderId: { type: "string" },
							amount: { type: "number" },
							entryType: { type: "string" },
						},
					},
				},
				currency: { type: "string" },
				description: { type: "string" },
				metadata: { type: "object" },
				idempotencyKey: { type: "string" },
			},
		},
		responses: { "201": { description: "Multi-transfer transaction created" } },
	},
	{
		method: "post",
		path: "/transactions/refund",
		summary: "Refund transaction",
		tag: "Transactions",
		requestBodySchema: {
			type: "object",
			required: ["transactionId"],
			properties: {
				transactionId: { type: "string" },
				reason: { type: "string" },
				amount: { type: "number", description: "Partial refund amount (optional)" },
				idempotencyKey: { type: "string" },
			},
		},
		responses: { "201": { description: "Refund transaction created" } },
	},
	{
		method: "get",
		path: "/transactions/{id}",
		summary: "Get transaction by ID",
		tag: "Transactions",
		responses: { "200": { description: "Transaction details" } },
	},

	// Holds
	{
		method: "get",
		path: "/holds",
		summary: "List all holds",
		tag: "Holds",
		responses: { "200": { description: "Paginated list of holds" } },
	},
	{
		method: "get",
		path: "/holds/active",
		summary: "List active holds",
		tag: "Holds",
		responses: { "200": { description: "Paginated list of active holds" } },
	},
	{
		method: "post",
		path: "/holds",
		summary: "Create hold",
		tag: "Holds",
		responses: { "201": { description: "Hold created" } },
	},
	{
		method: "post",
		path: "/holds/{holdId}/commit",
		summary: "Commit hold",
		tag: "Holds",
		responses: { "200": { description: "Hold committed" } },
	},
	{
		method: "post",
		path: "/holds/{holdId}/void",
		summary: "Void hold",
		tag: "Holds",
		responses: { "200": { description: "Hold voided" } },
	},
	{
		method: "get",
		path: "/holds/{id}",
		summary: "Get hold by ID",
		tag: "Holds",
		responses: { "200": { description: "Hold details" } },
	},

	// Limits
	{
		method: "post",
		path: "/limits",
		summary: "Set velocity limit",
		tag: "Limits",
		responses: { "201": { description: "Limit set" } },
	},
	{
		method: "get",
		path: "/limits/{holderId}",
		summary: "Get limits for holder",
		tag: "Limits",
		responses: { "200": { description: "List of limits" } },
	},
	{
		method: "delete",
		path: "/limits/{holderId}",
		summary: "Remove limit",
		tag: "Limits",
		responses: { "204": { description: "Limit removed" } },
	},
	{
		method: "get",
		path: "/limits/{holderId}/usage",
		summary: "Get limit usage",
		tag: "Limits",
		responses: { "200": { description: "Usage summary" } },
	},

	// Events
	{
		method: "get",
		path: "/events/correlation/{correlationId}",
		summary: "Get events by correlation ID",
		tag: "Events",
		responses: { "200": { description: "List of events" } },
	},
	{
		method: "post",
		path: "/events/verify",
		summary: "Verify hash chain integrity",
		tag: "Events",
		responses: { "200": { description: "Verification result" } },
	},
	{
		method: "get",
		path: "/events/{aggregateType}/{aggregateId}",
		summary: "Get events for aggregate",
		tag: "Events",
		responses: { "200": { description: "List of events" } },
	},
];

// =============================================================================
// SPEC BUILDER
// =============================================================================

function extractParams(path: string): string[] {
	const params: string[] = [];
	const regex = /\{(\w+)\}/g;
	for (const match of path.matchAll(regex)) {
		if (match[1]) params.push(match[1]);
	}
	return params;
}

function buildSpec(
	opts: OpenApiOptions,
	pluginEndpoints: Array<{ method: string; path: string }>,
): Record<string, unknown> {
	const paths: Record<string, Record<string, unknown>> = {};

	// Core routes
	for (const route of CORE_ROUTES) {
		if (!paths[route.path]) paths[route.path] = {};
		const params = extractParams(route.path);
		const operation: Record<string, unknown> = {
			summary: route.summary,
			tags: [route.tag],
			responses: route.responses,
		};
		if (params.length > 0) {
			operation.parameters = params.map((p) => ({
				name: p,
				in: "path",
				required: true,
				schema: { type: "string" },
			}));
		}
		if (route.method === "post" || route.method === "put" || route.method === "patch") {
			operation.requestBody = {
				required: true,
				content: {
					"application/json": {
						schema: route.requestBodySchema ?? { type: "object" },
					},
				},
			};
		}
		// Add response schemas if defined
		for (const [code, resDef] of Object.entries(route.responses)) {
			if (resDef.schema) {
				(operation.responses as Record<string, unknown>)[code] = {
					description: resDef.description,
					content: { "application/json": { schema: resDef.schema } },
				};
			}
		}
		paths[route.path]![route.method] = operation;
	}

	// Plugin-contributed endpoints (generic entries)
	for (const ep of pluginEndpoints) {
		// Convert :param to {param} for OpenAPI
		const openApiPath = ep.path.replace(/:(\w+)/g, "{$1}");
		if (!paths[openApiPath]) paths[openApiPath] = {};
		const method = ep.method.toLowerCase();
		const params = extractParams(openApiPath);
		const operation: Record<string, unknown> = {
			summary: `${method.toUpperCase()} ${openApiPath}`,
			tags: ["Plugins"],
			responses: { "200": { description: "Success" } },
		};
		if (params.length > 0) {
			operation.parameters = params.map((p) => ({
				name: p,
				in: "path",
				required: true,
				schema: { type: "string" },
			}));
		}
		paths[openApiPath]![method] = operation;
	}

	return {
		openapi: "3.1.0",
		info: {
			title: opts.title ?? "Summa Ledger API",
			version: opts.version ?? "0.1.0",
			description: opts.description ?? "Event-sourced double-entry financial ledger API",
		},
		servers: opts.servers ?? [],
		paths,
	};
}

// =============================================================================
// PLUGIN FACTORY
// =============================================================================

export function openApi(options?: OpenApiOptions): SummaPlugin {
	const opts = options ?? {};
	let cachedSpec: Record<string, unknown> | null = null;

	const endpoints: PluginEndpoint[] = [
		{
			method: "GET",
			path: "/openapi.json",
			handler: async (_req, ctx: SummaContext) => {
				if (!cachedSpec) {
					// Collect plugin endpoints (excluding this plugin's own)
					const pluginEndpoints: Array<{ method: string; path: string }> = [];
					for (const plugin of ctx.plugins) {
						if (plugin.id === "open-api" || !plugin.endpoints) continue;
						for (const ep of plugin.endpoints) {
							pluginEndpoints.push({ method: ep.method, path: ep.path });
						}
					}
					cachedSpec = buildSpec(opts, pluginEndpoints);
				}
				return { status: 200, body: cachedSpec };
			},
		},
	];

	return {
		id: "open-api",
		endpoints,
	};
}
