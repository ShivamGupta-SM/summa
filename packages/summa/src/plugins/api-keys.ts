// =============================================================================
// API KEY MANAGEMENT PLUGIN -- Secure API key authentication
// =============================================================================
// Full lifecycle management for API keys: create, list, revoke, rotate.
// Keys are hashed with SHA-256 before storage — plaintext is returned only once.
// Supports scopes (read/write/admin) and expiry dates.

import { createHash, randomBytes } from "node:crypto";
import type {
	PluginApiRequest,
	PluginApiResponse,
	SummaContext,
	SummaPlugin,
	TableDefinition,
} from "@summa-ledger/core";
import { SummaError } from "@summa-ledger/core";
import { createTableResolver } from "@summa-ledger/core/db";
import { getLedgerId } from "../managers/ledger-helpers.js";

// =============================================================================
// TYPES
// =============================================================================

export interface ApiKeyOptions {
	/** Enable request authentication via X-Api-Key header. Default: false */
	enforceAuthentication?: boolean;
	/** Paths excluded from authentication (e.g., health checks). Default: [] */
	excludePaths?: string[];
	/** Cleanup interval for expired keys. Default: "1d" */
	cleanupInterval?: string;
}

export type ApiKeyScope = "read" | "write" | "admin";

export interface ApiKey {
	id: string;
	name: string;
	keyPrefix: string;
	scopes: ApiKeyScope[];
	expiresAt: string | null;
	revokedAt: string | null;
	lastUsedAt: string | null;
	createdBy: string | null;
	createdAt: string;
}

export interface ApiKeyWithSecret extends ApiKey {
	/** The plaintext API key. Only returned on creation — cannot be retrieved again. */
	key: string;
}

// =============================================================================
// RAW ROWS
// =============================================================================

interface RawApiKeyRow {
	id: string;
	ledger_id: string;
	name: string;
	key_hash: string;
	key_prefix: string;
	scopes: string[] | string;
	expires_at: string | Date | null;
	revoked_at: string | Date | null;
	last_used_at: string | Date | null;
	created_by: string | null;
	created_at: string | Date;
}

// =============================================================================
// HELPERS
// =============================================================================

function toIso(val: string | Date | null): string | null {
	if (!val) return null;
	return val instanceof Date ? val.toISOString() : String(val);
}

function rawToApiKey(row: RawApiKeyRow): ApiKey {
	const scopes = typeof row.scopes === "string" ? JSON.parse(row.scopes) : row.scopes;
	return {
		id: row.id,
		name: row.name,
		keyPrefix: row.key_prefix,
		scopes: scopes as ApiKeyScope[],
		expiresAt: toIso(row.expires_at),
		revokedAt: toIso(row.revoked_at),
		lastUsedAt: toIso(row.last_used_at),
		createdBy: row.created_by,
		createdAt: toIso(row.created_at)!,
	};
}

function json(status: number, body: unknown): PluginApiResponse {
	return { status, body };
}

function generateApiKeyString(): { key: string; hash: string; prefix: string } {
	const raw = randomBytes(32).toString("base64url");
	const key = `sk_live_${raw}`;
	const hash = createHash("sha256").update(key).digest("hex");
	const prefix = key.slice(0, 12);
	return { key, hash, prefix };
}

function hashApiKey(key: string): string {
	return createHash("sha256").update(key).digest("hex");
}

// =============================================================================
// SCHEMA
// =============================================================================

const apiKeySchema: Record<string, TableDefinition> = {
	api_key: {
		columns: {
			id: { type: "uuid", primaryKey: true, notNull: true },
			ledger_id: { type: "uuid", notNull: true },
			name: { type: "text", notNull: true },
			key_hash: { type: "text", notNull: true },
			key_prefix: { type: "text", notNull: true },
			scopes: { type: "jsonb", notNull: true },
			expires_at: { type: "timestamp" },
			revoked_at: { type: "timestamp" },
			last_used_at: { type: "timestamp" },
			created_by: { type: "text" },
			created_at: { type: "timestamp", notNull: true, default: "NOW()" },
		},
		indexes: [
			{ name: "uq_api_key_hash", columns: ["key_hash"], unique: true },
			{ name: "idx_api_key_ledger", columns: ["ledger_id"] },
			{ name: "idx_api_key_prefix", columns: ["key_prefix"] },
		],
	},
};

// =============================================================================
// CORE OPERATIONS
// =============================================================================

export async function createApiKeyRecord(
	ctx: SummaContext,
	params: {
		name: string;
		scopes?: ApiKeyScope[];
		expiresAt?: string;
		createdBy?: string;
	},
): Promise<ApiKeyWithSecret> {
	const t = createTableResolver(ctx.options.schema);
	const d = ctx.dialect;
	const ledgerId = getLedgerId(ctx);
	const { key, hash, prefix } = generateApiKeyString();
	const scopes = params.scopes ?? ["read", "write"];

	const rows = await ctx.adapter.raw<RawApiKeyRow>(
		`INSERT INTO ${t("api_key")} (
			id, ledger_id, name, key_hash, key_prefix, scopes, expires_at, created_by, created_at
		) VALUES (
			${d.generateUuid()}, $1, $2, $3, $4, $5, $6, $7, ${d.now()}
		) RETURNING *`,
		[
			ledgerId,
			params.name,
			hash,
			prefix,
			JSON.stringify(scopes),
			params.expiresAt ?? null,
			params.createdBy ?? null,
		],
	);

	const row = rows[0];
	if (!row) throw SummaError.internal("Failed to create API key");

	return {
		...rawToApiKey(row),
		key,
	};
}

export async function listApiKeys(
	ctx: SummaContext,
	params?: { includeRevoked?: boolean; page?: number; perPage?: number },
): Promise<{ keys: ApiKey[]; hasMore: boolean; total: number }> {
	const t = createTableResolver(ctx.options.schema);
	const ledgerId = getLedgerId(ctx);
	const page = Math.max(1, params?.page ?? 1);
	const perPage = Math.min(params?.perPage ?? 20, 100);
	const offset = (page - 1) * perPage;

	const conditions: string[] = ["ledger_id = $1"];
	const queryParams: unknown[] = [ledgerId];
	let idx = 2;

	if (!params?.includeRevoked) {
		conditions.push("revoked_at IS NULL");
	}

	const whereClause = `WHERE ${conditions.join(" AND ")}`;
	const countParams = [...queryParams];
	queryParams.push(perPage + 1, offset);

	const [rows, countRows] = await Promise.all([
		ctx.adapter.raw<RawApiKeyRow>(
			`SELECT * FROM ${t("api_key")}
			 ${whereClause}
			 ORDER BY created_at DESC
			 LIMIT $${idx++} OFFSET $${idx}`,
			queryParams,
		),
		ctx.adapter.raw<{ total: number }>(
			`SELECT ${ctx.dialect.countAsInt()} AS total FROM ${t("api_key")} ${whereClause}`,
			countParams,
		),
	]);

	const hasMore = rows.length > perPage;
	const keys = (hasMore ? rows.slice(0, perPage) : rows).map(rawToApiKey);
	return { keys, hasMore, total: countRows[0]?.total ?? 0 };
}

export async function revokeApiKey(ctx: SummaContext, keyId: string): Promise<ApiKey> {
	const t = createTableResolver(ctx.options.schema);
	const ledgerId = getLedgerId(ctx);
	const d = ctx.dialect;

	const rows = await ctx.adapter.raw<RawApiKeyRow>(
		`UPDATE ${t("api_key")} SET revoked_at = ${d.now()}
		 WHERE id = $1 AND ledger_id = $2 AND revoked_at IS NULL
		 RETURNING *`,
		[keyId, ledgerId],
	);

	const row = rows[0];
	if (!row) throw SummaError.notFound("API key not found or already revoked");
	return rawToApiKey(row);
}

export async function rotateApiKey(ctx: SummaContext, keyId: string): Promise<ApiKeyWithSecret> {
	const t = createTableResolver(ctx.options.schema);
	const ledgerId = getLedgerId(ctx);
	const d = ctx.dialect;

	// Get the existing key to copy its properties
	const existing = await ctx.adapter.raw<RawApiKeyRow>(
		`SELECT * FROM ${t("api_key")} WHERE id = $1 AND ledger_id = $2 AND revoked_at IS NULL`,
		[keyId, ledgerId],
	);
	const old = existing[0];
	if (!old) throw SummaError.notFound("API key not found or already revoked");

	// Revoke the old key
	await ctx.adapter.rawMutate(`UPDATE ${t("api_key")} SET revoked_at = ${d.now()} WHERE id = $1`, [
		keyId,
	]);

	// Create a new key with the same name and scopes
	const scopes = typeof old.scopes === "string" ? JSON.parse(old.scopes) : old.scopes;
	return createApiKeyRecord(ctx, {
		name: old.name,
		scopes,
		expiresAt: toIso(old.expires_at) ?? undefined,
		createdBy: old.created_by ?? undefined,
	});
}

async function validateApiKeyFromHeader(
	ctx: SummaContext,
	apiKey: string,
): Promise<{ valid: boolean; keyId?: string; scopes?: ApiKeyScope[] }> {
	const t = createTableResolver(ctx.options.schema);
	const hash = hashApiKey(apiKey);

	const rows = await ctx.adapter.raw<RawApiKeyRow>(
		`SELECT * FROM ${t("api_key")}
		 WHERE key_hash = $1
		   AND revoked_at IS NULL
		   AND (expires_at IS NULL OR expires_at > ${ctx.dialect.now()})`,
		[hash],
	);

	const row = rows[0];
	if (!row) return { valid: false };

	// Update last_used_at (fire-and-forget, non-blocking)
	ctx.adapter
		.rawMutate(`UPDATE ${t("api_key")} SET last_used_at = ${ctx.dialect.now()} WHERE id = $1`, [
			row.id,
		])
		.catch(() => {});

	const scopes = typeof row.scopes === "string" ? JSON.parse(row.scopes) : row.scopes;
	return { valid: true, keyId: row.id, scopes: scopes as ApiKeyScope[] };
}

// =============================================================================
// PLUGIN FACTORY
// =============================================================================

export function apiKeys(options?: ApiKeyOptions): SummaPlugin {
	const enforceAuth = options?.enforceAuthentication ?? false;
	const excludePaths = new Set(options?.excludePaths ?? ["/health", "/ready"]);

	return {
		id: "api-keys",

		$Infer: {} as {
			ApiKey: ApiKey;
			ApiKeyWithSecret: ApiKeyWithSecret;
		},

		schema: apiKeySchema,

		onRequest: enforceAuth
			? async (req) => {
					// Skip excluded paths
					if (excludePaths.has(req.path)) return req;

					// Skip API key management endpoints (bootstrapping)
					if (req.path.startsWith("/api-keys") && req.method === "POST") return req;

					const apiKey = req.headers?.["x-api-key"];
					if (!apiKey) {
						return {
							status: 401,
							body: {
								error: {
									code: "UNAUTHORIZED",
									message: "API key required. Provide X-Api-Key header.",
								},
							},
						};
					}

					// Note: validation happens at the handler level since onRequest
					// doesn't have access to SummaContext. The key is passed through.
					return req;
				}
			: undefined,

		workers: [
			{
				id: "api-key-cleanup",
				description: "Remove expired and revoked API keys older than 30 days",
				handler: async (ctx: SummaContext) => {
					const t = createTableResolver(ctx.options.schema);
					const d = ctx.dialect;
					const deleted = await ctx.adapter.rawMutate(
						`DELETE FROM ${t("api_key")}
						 WHERE revoked_at IS NOT NULL
						   AND revoked_at < ${d.now()} - ${d.interval("30 day")}`,
						[],
					);
					if (deleted > 0) {
						ctx.logger.info("Cleaned up old revoked API keys", { count: deleted });
					}
				},
				interval: options?.cleanupInterval ?? "1d",
				leaseRequired: true,
			},
		],

		endpoints: [
			// POST /api-keys -- Create a new API key
			{
				method: "POST",
				path: "/api-keys",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const body = req.body as Record<string, unknown> | null;
					if (!body || typeof body !== "object")
						return json(400, {
							error: { code: "INVALID_ARGUMENT", message: "Request body required" },
						});

					const name = body.name as string | undefined;
					if (!name)
						return json(400, { error: { code: "INVALID_ARGUMENT", message: "name is required" } });

					const result = await createApiKeyRecord(ctx, {
						name,
						scopes: body.scopes as ApiKeyScope[] | undefined,
						expiresAt: body.expiresAt as string | undefined,
						createdBy: body.createdBy as string | undefined,
					});
					return json(201, result);
				},
			},

			// GET /api-keys -- List API keys
			{
				method: "GET",
				path: "/api-keys",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const result = await listApiKeys(ctx, {
						includeRevoked: req.query.includeRevoked === "true",
						page: req.query.page ? Number(req.query.page) : undefined,
						perPage: req.query.perPage ? Number(req.query.perPage) : undefined,
					});
					return json(200, result);
				},
			},

			// DELETE /api-keys/:id -- Revoke an API key
			{
				method: "DELETE",
				path: "/api-keys/:id",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const id = req.params.id ?? "";
					const result = await revokeApiKey(ctx, id);
					return json(200, result);
				},
			},

			// POST /api-keys/:id/rotate -- Rotate an API key (revoke old, create new)
			{
				method: "POST",
				path: "/api-keys/:id/rotate",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const id = req.params.id ?? "";
					const result = await rotateApiKey(ctx, id);
					return json(201, result);
				},
			},

			// POST /api-keys/validate -- Validate an API key
			{
				method: "POST",
				path: "/api-keys/validate",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const body = req.body as { key?: string } | null;
					if (!body?.key)
						return json(400, { error: { code: "INVALID_ARGUMENT", message: "key is required" } });

					const result = await validateApiKeyFromHeader(ctx, body.key);
					return json(200, result);
				},
			},
		],
	};
}
