// =============================================================================
// IDENTITY MANAGEMENT PLUGIN -- User identity CRUD with PII tokenization
// =============================================================================
// Manages user/entity identities with first-class PII protection.
// Supports AES-256-GCM encryption for sensitive fields (name, email, phone, address).
// Identities can be linked to accounts for KYC/compliance workflows.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
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

export interface IdentityOptions {
	/** Secret key for PII encryption (32 bytes hex or base64). Required for tokenization. */
	encryptionSecret?: string;
	/** Fields to auto-tokenize on create/update. Default: none (explicit tokenization) */
	autoTokenizeFields?: TokenizableField[];
	/** Retention days for soft-deleted identities. Default: 365 */
	retentionDays?: number;
}

export type TokenizableField =
	| "first_name"
	| "last_name"
	| "email"
	| "phone"
	| "street"
	| "city"
	| "state"
	| "postal_code"
	| "country";

export interface Identity {
	id: string;
	holderId: string;
	firstName: string | null;
	lastName: string | null;
	email: string | null;
	phone: string | null;
	organizationName: string | null;
	street: string | null;
	city: string | null;
	state: string | null;
	postalCode: string | null;
	country: string | null;
	metadata: Record<string, unknown>;
	createdAt: string;
	updatedAt: string;
}

export interface TokenizedFieldInfo {
	fieldName: string;
	tokenized: boolean;
	tokenizedAt: string | null;
}

// =============================================================================
// RAW ROWS
// =============================================================================

interface RawIdentityRow {
	id: string;
	ledger_id: string;
	holder_id: string;
	first_name: string | null;
	last_name: string | null;
	email: string | null;
	phone: string | null;
	organization_name: string | null;
	street: string | null;
	city: string | null;
	state: string | null;
	postal_code: string | null;
	country: string | null;
	metadata: Record<string, unknown> | string | null;
	created_at: string | Date;
	updated_at: string | Date;
}

interface RawTokenRow {
	id: string;
	identity_id: string;
	field_name: string;
	encrypted_value: string;
	created_at: string | Date;
}

// =============================================================================
// HELPERS
// =============================================================================

function toIso(val: string | Date): string {
	return val instanceof Date ? val.toISOString() : String(val);
}

function parseJsonb(val: Record<string, unknown> | string | null): Record<string, unknown> {
	if (!val) return {};
	if (typeof val === "string") return JSON.parse(val);
	return val;
}

function rawToIdentity(row: RawIdentityRow): Identity {
	return {
		id: row.id,
		holderId: row.holder_id,
		firstName: row.first_name,
		lastName: row.last_name,
		email: row.email,
		phone: row.phone,
		organizationName: row.organization_name,
		street: row.street,
		city: row.city,
		state: row.state,
		postalCode: row.postal_code,
		country: row.country,
		metadata: parseJsonb(row.metadata),
		createdAt: toIso(row.created_at),
		updatedAt: toIso(row.updated_at),
	};
}

function json(status: number, body: unknown): PluginApiResponse {
	return { status, body };
}

// =============================================================================
// ENCRYPTION (AES-256-GCM)
// =============================================================================

function deriveKey(secret: string): Buffer {
	return createHash("sha256").update(secret).digest();
}

export function encryptField(value: string, secret: string): string {
	const key = deriveKey(secret);
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
	const authTag = cipher.getAuthTag();
	return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

export function decryptField(token: string, secret: string): string {
	const parts = token.split(":");
	if (parts.length !== 3) throw SummaError.invalidArgument("Invalid encrypted token format");
	const [ivHex, tagHex, encHex] = parts as [string, string, string];
	const key = deriveKey(secret);
	const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
	decipher.setAuthTag(Buffer.from(tagHex, "hex"));
	const decrypted = Buffer.concat([decipher.update(Buffer.from(encHex, "hex")), decipher.final()]);
	return decrypted.toString("utf8");
}

// =============================================================================
// SCHEMA
// =============================================================================

const identitySchema: Record<string, TableDefinition> = {
	identity: {
		columns: {
			id: { type: "uuid", primaryKey: true, notNull: true },
			ledger_id: { type: "uuid", notNull: true },
			holder_id: { type: "text", notNull: true },
			first_name: { type: "text" },
			last_name: { type: "text" },
			email: { type: "text" },
			phone: { type: "text" },
			organization_name: { type: "text" },
			street: { type: "text" },
			city: { type: "text" },
			state: { type: "text" },
			postal_code: { type: "text" },
			country: { type: "text" },
			metadata: { type: "jsonb", notNull: true, default: "'{}'" },
			created_at: { type: "timestamp", notNull: true, default: "NOW()" },
			updated_at: { type: "timestamp", notNull: true, default: "NOW()" },
		},
		indexes: [
			{ name: "idx_identity_ledger", columns: ["ledger_id"] },
			{ name: "uq_identity_holder", columns: ["ledger_id", "holder_id"], unique: true },
			{ name: "idx_identity_email", columns: ["email"] },
		],
	},
	identity_token: {
		columns: {
			id: { type: "uuid", primaryKey: true, notNull: true },
			identity_id: {
				type: "uuid",
				notNull: true,
				references: { table: "identity", column: "id" },
			},
			field_name: { type: "text", notNull: true },
			encrypted_value: { type: "text", notNull: true },
			created_at: { type: "timestamp", notNull: true, default: "NOW()" },
		},
		indexes: [
			{
				name: "uq_identity_token_field",
				columns: ["identity_id", "field_name"],
				unique: true,
			},
		],
	},
};

// =============================================================================
// CORE OPERATIONS
// =============================================================================

async function createIdentityRecord(
	ctx: SummaContext,
	params: {
		holderId: string;
		firstName?: string;
		lastName?: string;
		email?: string;
		phone?: string;
		organizationName?: string;
		street?: string;
		city?: string;
		state?: string;
		postalCode?: string;
		country?: string;
		metadata?: Record<string, unknown>;
	},
): Promise<Identity> {
	const t = createTableResolver(ctx.options.schema);
	const ledgerId = getLedgerId(ctx);
	const d = ctx.dialect;

	const rows = await ctx.adapter.raw<RawIdentityRow>(
		`INSERT INTO ${t("identity")} (
			id, ledger_id, holder_id, first_name, last_name, email, phone,
			organization_name, street, city, state, postal_code, country, metadata,
			created_at, updated_at
		) VALUES (
			${d.generateUuid()}, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
			${d.now()}, ${d.now()}
		) RETURNING *`,
		[
			ledgerId,
			params.holderId,
			params.firstName ?? null,
			params.lastName ?? null,
			params.email ?? null,
			params.phone ?? null,
			params.organizationName ?? null,
			params.street ?? null,
			params.city ?? null,
			params.state ?? null,
			params.postalCode ?? null,
			params.country ?? null,
			JSON.stringify(params.metadata ?? {}),
		],
	);

	const row = rows[0];
	if (!row) throw SummaError.internal("Failed to create identity");
	return rawToIdentity(row);
}

async function getIdentityRecord(ctx: SummaContext, identityId: string): Promise<Identity> {
	const t = createTableResolver(ctx.options.schema);
	const ledgerId = getLedgerId(ctx);

	const rows = await ctx.adapter.raw<RawIdentityRow>(
		`SELECT * FROM ${t("identity")} WHERE id = $1 AND ledger_id = $2`,
		[identityId, ledgerId],
	);

	const row = rows[0];
	if (!row) throw SummaError.notFound("Identity not found");
	return rawToIdentity(row);
}

async function getIdentityByHolder(ctx: SummaContext, holderId: string): Promise<Identity> {
	const t = createTableResolver(ctx.options.schema);
	const ledgerId = getLedgerId(ctx);

	const rows = await ctx.adapter.raw<RawIdentityRow>(
		`SELECT * FROM ${t("identity")} WHERE holder_id = $1 AND ledger_id = $2`,
		[holderId, ledgerId],
	);

	const row = rows[0];
	if (!row) throw SummaError.notFound("Identity not found");
	return rawToIdentity(row);
}

async function updateIdentityRecord(
	ctx: SummaContext,
	identityId: string,
	params: Partial<{
		firstName: string;
		lastName: string;
		email: string;
		phone: string;
		organizationName: string;
		street: string;
		city: string;
		state: string;
		postalCode: string;
		country: string;
		metadata: Record<string, unknown>;
	}>,
): Promise<Identity> {
	const t = createTableResolver(ctx.options.schema);
	const ledgerId = getLedgerId(ctx);
	const d = ctx.dialect;

	const sets: string[] = [];
	const queryParams: unknown[] = [];
	let idx = 1;

	const fieldMap: Record<string, string> = {
		firstName: "first_name",
		lastName: "last_name",
		email: "email",
		phone: "phone",
		organizationName: "organization_name",
		street: "street",
		city: "city",
		state: "state",
		postalCode: "postal_code",
		country: "country",
	};

	for (const [camel, snake] of Object.entries(fieldMap)) {
		const value = params[camel as keyof typeof params];
		if (value !== undefined) {
			sets.push(`${snake} = $${idx++}`);
			queryParams.push(value);
		}
	}

	if (params.metadata !== undefined) {
		sets.push(`metadata = $${idx++}`);
		queryParams.push(JSON.stringify(params.metadata));
	}

	if (sets.length === 0) throw SummaError.invalidArgument("No fields to update");

	sets.push(`updated_at = ${d.now()}`);
	queryParams.push(identityId, ledgerId);

	const rows = await ctx.adapter.raw<RawIdentityRow>(
		`UPDATE ${t("identity")} SET ${sets.join(", ")}
		 WHERE id = $${idx++} AND ledger_id = $${idx}
		 RETURNING *`,
		queryParams,
	);

	const row = rows[0];
	if (!row) throw SummaError.notFound("Identity not found");
	return rawToIdentity(row);
}

async function deleteIdentityRecord(ctx: SummaContext, identityId: string): Promise<void> {
	const t = createTableResolver(ctx.options.schema);
	const ledgerId = getLedgerId(ctx);

	// Delete tokens first (FK constraint)
	await ctx.adapter.rawMutate(`DELETE FROM ${t("identity_token")} WHERE identity_id = $1`, [
		identityId,
	]);

	const deleted = await ctx.adapter.rawMutate(
		`DELETE FROM ${t("identity")} WHERE id = $1 AND ledger_id = $2`,
		[identityId, ledgerId],
	);

	if (deleted === 0) throw SummaError.notFound("Identity not found");
}

async function listIdentityRecords(
	ctx: SummaContext,
	params?: { page?: number; perPage?: number; search?: string },
): Promise<{ identities: Identity[]; hasMore: boolean; total: number }> {
	const t = createTableResolver(ctx.options.schema);
	const ledgerId = getLedgerId(ctx);
	const page = Math.max(1, params?.page ?? 1);
	const perPage = Math.min(params?.perPage ?? 20, 100);
	const offset = (page - 1) * perPage;

	const conditions: string[] = ["ledger_id = $1"];
	const queryParams: unknown[] = [ledgerId];
	let idx = 2;

	if (params?.search) {
		conditions.push(
			`(first_name ILIKE $${idx} OR last_name ILIKE $${idx} OR email ILIKE $${idx} OR phone ILIKE $${idx} OR holder_id ILIKE $${idx})`,
		);
		queryParams.push(`%${params.search}%`);
		idx++;
	}

	const whereClause = `WHERE ${conditions.join(" AND ")}`;
	const countParams = [...queryParams];

	queryParams.push(perPage + 1, offset);

	const [rows, countRows] = await Promise.all([
		ctx.adapter.raw<RawIdentityRow>(
			`SELECT * FROM ${t("identity")}
			 ${whereClause}
			 ORDER BY created_at DESC
			 LIMIT $${idx++} OFFSET $${idx}`,
			queryParams,
		),
		ctx.adapter.raw<{ total: number }>(
			`SELECT ${ctx.dialect.countAsInt()} AS total FROM ${t("identity")} ${whereClause}`,
			countParams,
		),
	]);

	const hasMore = rows.length > perPage;
	const identities = (hasMore ? rows.slice(0, perPage) : rows).map(rawToIdentity);
	return { identities, hasMore, total: countRows[0]?.total ?? 0 };
}

// =============================================================================
// TOKENIZATION OPERATIONS
// =============================================================================

async function tokenizeIdentityFields(
	ctx: SummaContext,
	identityId: string,
	fields: TokenizableField[],
	secret: string,
): Promise<TokenizedFieldInfo[]> {
	const t = createTableResolver(ctx.options.schema);
	const d = ctx.dialect;
	const identity = await getIdentityRecord(ctx, identityId);

	const results: TokenizedFieldInfo[] = [];

	for (const field of fields) {
		const fieldMap: Record<TokenizableField, string | null> = {
			first_name: identity.firstName,
			last_name: identity.lastName,
			email: identity.email,
			phone: identity.phone,
			street: identity.street,
			city: identity.city,
			state: identity.state,
			postal_code: identity.postalCode,
			country: identity.country,
		};

		const value = fieldMap[field];
		if (!value) {
			results.push({ fieldName: field, tokenized: false, tokenizedAt: null });
			continue;
		}

		const encrypted = encryptField(value, secret);

		// Upsert token
		await ctx.adapter.rawMutate(
			`INSERT INTO ${t("identity_token")} (id, identity_id, field_name, encrypted_value, created_at)
			 VALUES (${d.generateUuid()}, $1, $2, $3, ${d.now()})
			 ${d.onConflictDoUpdate(["identity_id", "field_name"], { encrypted_value: "EXCLUDED.encrypted_value" })}`,
			[identityId, field, encrypted],
		);

		// Clear the original field on the identity record
		await ctx.adapter.rawMutate(
			`UPDATE ${t("identity")} SET ${field} = NULL, updated_at = ${d.now()} WHERE id = $1`,
			[identityId],
		);

		results.push({ fieldName: field, tokenized: true, tokenizedAt: new Date().toISOString() });
	}

	return results;
}

async function detokenizeIdentityFields(
	ctx: SummaContext,
	identityId: string,
	fields: TokenizableField[],
	secret: string,
): Promise<Record<string, string>> {
	const t = createTableResolver(ctx.options.schema);

	const result: Record<string, string> = {};

	for (const field of fields) {
		const rows = await ctx.adapter.raw<RawTokenRow>(
			`SELECT * FROM ${t("identity_token")}
			 WHERE identity_id = $1 AND field_name = $2`,
			[identityId, field],
		);

		const row = rows[0];
		if (!row) continue;

		result[field] = decryptField(row.encrypted_value, secret);
	}

	return result;
}

async function listTokenizedFields(
	ctx: SummaContext,
	identityId: string,
): Promise<TokenizedFieldInfo[]> {
	const t = createTableResolver(ctx.options.schema);

	const rows = await ctx.adapter.raw<RawTokenRow>(
		`SELECT * FROM ${t("identity_token")} WHERE identity_id = $1`,
		[identityId],
	);

	return rows.map((row) => ({
		fieldName: row.field_name,
		tokenized: true,
		tokenizedAt: toIso(row.created_at),
	}));
}

async function linkIdentityToAccount(
	ctx: SummaContext,
	identityId: string,
	accountId: string,
): Promise<void> {
	const t = createTableResolver(ctx.options.schema);
	const ledgerId = getLedgerId(ctx);

	// Verify identity exists
	await getIdentityRecord(ctx, identityId);

	// Update account's metadata to include identity_id
	const updated = await ctx.adapter.rawMutate(
		`UPDATE ${t("account")}
		 SET metadata = jsonb_set(COALESCE(metadata, '{}'), '{identity_id}', to_jsonb($1::text)),
		     updated_at = ${ctx.dialect.now()}
		 WHERE id = $2 AND ledger_id = $3`,
		[identityId, accountId, ledgerId],
	);

	if (updated === 0) throw SummaError.notFound("Account not found");
}

// =============================================================================
// PLUGIN FACTORY
// =============================================================================

export function identity(options?: IdentityOptions): SummaPlugin {
	const encryptionSecret = options?.encryptionSecret;

	return {
		id: "identity",

		$Infer: {} as {
			Identity: Identity;
			TokenizedFieldInfo: TokenizedFieldInfo;
		},

		schema: identitySchema,

		operationHooks: options?.autoTokenizeFields?.length
			? {
					after: [
						{
							matcher: (op) => op.type === "account.create",
							handler: async ({ operation, context }) => {
								if (!encryptionSecret) return;
								const params = operation.params as Record<string, unknown>;
								const holderId = params.holderId as string | undefined;
								if (!holderId) return;

								// Try to find identity for this holder and auto-tokenize
								const t = createTableResolver(context.options.schema);
								const ledgerId = getLedgerId(context);
								const rows = await context.adapter.raw<RawIdentityRow>(
									`SELECT id FROM ${t("identity")} WHERE holder_id = $1 AND ledger_id = $2`,
									[holderId, ledgerId],
								);
								if (rows[0]) {
									await tokenizeIdentityFields(
										context,
										rows[0].id,
										options!.autoTokenizeFields!,
										encryptionSecret,
									);
								}
							},
						},
					],
				}
			: undefined,

		endpoints: [
			// POST /identities -- Create identity
			{
				method: "POST",
				path: "/identities",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const body = req.body as Record<string, unknown> | null;
					if (!body || typeof body !== "object")
						return json(400, {
							error: { code: "INVALID_ARGUMENT", message: "Request body required" },
						});

					const holderId = body.holderId as string | undefined;
					if (!holderId)
						return json(400, {
							error: { code: "INVALID_ARGUMENT", message: "holderId is required" },
						});

					const result = await createIdentityRecord(ctx, {
						holderId,
						firstName: body.firstName as string | undefined,
						lastName: body.lastName as string | undefined,
						email: body.email as string | undefined,
						phone: body.phone as string | undefined,
						organizationName: body.organizationName as string | undefined,
						street: body.street as string | undefined,
						city: body.city as string | undefined,
						state: body.state as string | undefined,
						postalCode: body.postalCode as string | undefined,
						country: body.country as string | undefined,
						metadata: body.metadata as Record<string, unknown> | undefined,
					});
					return json(201, result);
				},
			},

			// GET /identities/:id -- Get identity by ID
			{
				method: "GET",
				path: "/identities/:id",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const id = req.params.id ?? "";
					const result = await getIdentityRecord(ctx, id);
					return json(200, result);
				},
			},

			// GET /identities/by-holder/:holderId -- Get identity by holder ID
			{
				method: "GET",
				path: "/identities/by-holder/:holderId",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const holderId = req.params.holderId ?? "";
					const result = await getIdentityByHolder(ctx, holderId);
					return json(200, result);
				},
			},

			// PUT /identities/:id -- Update identity
			{
				method: "PUT",
				path: "/identities/:id",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const body = req.body as Record<string, unknown> | null;
					if (!body || typeof body !== "object")
						return json(400, {
							error: { code: "INVALID_ARGUMENT", message: "Request body required" },
						});

					const id = req.params.id ?? "";
					const result = await updateIdentityRecord(ctx, id, body);
					return json(200, result);
				},
			},

			// DELETE /identities/:id -- Delete identity
			{
				method: "DELETE",
				path: "/identities/:id",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const id = req.params.id ?? "";
					await deleteIdentityRecord(ctx, id);
					return json(200, { deleted: true });
				},
			},

			// GET /identities -- List identities
			{
				method: "GET",
				path: "/identities",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const result = await listIdentityRecords(ctx, {
						page: req.query.page ? Number(req.query.page) : undefined,
						perPage: req.query.perPage ? Number(req.query.perPage) : undefined,
						search: req.query.search,
					});
					return json(200, result);
				},
			},

			// POST /identities/:id/tokenize -- Tokenize PII fields
			{
				method: "POST",
				path: "/identities/:id/tokenize",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					if (!encryptionSecret)
						return json(400, {
							error: { code: "CONFIGURATION_ERROR", message: "encryptionSecret not configured" },
						});

					const body = req.body as { fields?: TokenizableField[] } | null;
					if (!body?.fields?.length)
						return json(400, {
							error: { code: "INVALID_ARGUMENT", message: "fields array required" },
						});

					const id = req.params.id ?? "";
					const result = await tokenizeIdentityFields(ctx, id, body.fields, encryptionSecret);
					return json(200, { results: result });
				},
			},

			// POST /identities/:id/detokenize -- Detokenize PII fields
			{
				method: "POST",
				path: "/identities/:id/detokenize",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					if (!encryptionSecret)
						return json(400, {
							error: { code: "CONFIGURATION_ERROR", message: "encryptionSecret not configured" },
						});

					const body = req.body as { fields?: TokenizableField[] } | null;
					if (!body?.fields?.length)
						return json(400, {
							error: { code: "INVALID_ARGUMENT", message: "fields array required" },
						});

					const id = req.params.id ?? "";
					const result = await detokenizeIdentityFields(ctx, id, body.fields, encryptionSecret);
					return json(200, result);
				},
			},

			// GET /identities/:id/tokenized-fields -- List tokenized fields
			{
				method: "GET",
				path: "/identities/:id/tokenized-fields",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const id = req.params.id ?? "";
					const result = await listTokenizedFields(ctx, id);
					return json(200, { fields: result });
				},
			},

			// PUT /identities/:identityId/link/:accountId -- Link identity to account
			{
				method: "PUT",
				path: "/identities/:identityId/link/:accountId",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const identityId = req.params.identityId ?? "";
					const accountId = req.params.accountId ?? "";
					await linkIdentityToAccount(ctx, identityId, accountId);
					return json(200, { linked: true });
				},
			},
		],
	};
}

// =============================================================================
// QUERY FUNCTIONS (for external consumers)
// =============================================================================

export { createIdentityRecord as createIdentity };
export { getIdentityRecord as getIdentity };
export { getIdentityByHolder };
export { updateIdentityRecord as updateIdentity };
export { deleteIdentityRecord as deleteIdentity };
export { listIdentityRecords as listIdentities };
export { tokenizeIdentityFields as tokenizeFields };
export { detokenizeIdentityFields as detokenizeFields };
export { listTokenizedFields };
export { linkIdentityToAccount };
