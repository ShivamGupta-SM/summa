// =============================================================================
// SEARCH PLUGIN -- Full-text search with pluggable backends
// =============================================================================
// Provides full-text search across accounts, transactions, and identities.
// Supports Typesense and Meilisearch as backends.
// Auto-indexes on write via afterTransaction and afterAccountCreate hooks.

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

export interface SearchOptions {
	/** Search backend implementation */
	backend: SearchBackend;
	/** Collections to index. Default: ["accounts", "transactions"] */
	collections?: SearchCollection[];
	/** Batch size for reindexing. Default: 500 */
	reindexBatchSize?: number;
}

export type SearchCollection = "accounts" | "transactions" | "identities";

export interface SearchBackend {
	/** Initialize the backend (create collections/indexes) */
	initialize(collections: SearchCollectionConfig[]): Promise<void>;
	/** Index a single document */
	index(collection: string, document: Record<string, unknown>): Promise<void>;
	/** Index multiple documents */
	indexBatch(collection: string, documents: Record<string, unknown>[]): Promise<void>;
	/** Search a collection */
	search(collection: string, query: SearchQuery): Promise<SearchResult>;
	/** Delete a document from the index */
	delete(collection: string, documentId: string): Promise<void>;
	/** Multi-search across collections */
	multiSearch?(queries: Array<{ collection: string; query: SearchQuery }>): Promise<SearchResult[]>;
	/** Optional: set the Summa context for backends that need DB access (e.g. pgSearchBackend) */
	setContext?(ctx: SummaContext): void;
}

export interface SearchCollectionConfig {
	name: string;
	fields: SearchFieldConfig[];
}

export interface SearchFieldConfig {
	name: string;
	type: "string" | "int64" | "float" | "bool" | "string[]";
	facet?: boolean;
	index?: boolean;
	optional?: boolean;
	sort?: boolean;
}

export interface SearchQuery {
	q: string;
	queryBy?: string[];
	filterBy?: string;
	sortBy?: string;
	page?: number;
	perPage?: number;
	facetBy?: string[];
}

export interface SearchResult {
	hits: SearchHit[];
	found: number;
	page: number;
	totalPages: number;
	facetCounts?: Record<string, Array<{ value: string; count: number }>>;
}

export interface SearchHit {
	document: Record<string, unknown>;
	highlights?: Array<{
		field: string;
		snippet: string;
		matchedTokens: string[];
	}>;
	score?: number;
}

export interface ReindexStatus {
	collection: string;
	status: "idle" | "in_progress" | "completed" | "failed";
	totalDocuments: number;
	indexedDocuments: number;
	startedAt: string | null;
	completedAt: string | null;
	errorMessage: string | null;
}

// =============================================================================
// COLLECTION SCHEMAS
// =============================================================================

const COLLECTION_SCHEMAS: Record<SearchCollection, SearchCollectionConfig> = {
	accounts: {
		name: "accounts",
		fields: [
			{ name: "id", type: "string" },
			{ name: "holder_id", type: "string" },
			{ name: "holder_type", type: "string", facet: true },
			{ name: "currency", type: "string", facet: true },
			{ name: "status", type: "string", facet: true },
			{ name: "account_type", type: "string", facet: true, optional: true },
			{ name: "account_code", type: "string", optional: true },
			{ name: "balance", type: "int64", sort: true },
			{ name: "created_at", type: "int64", sort: true },
		],
	},
	transactions: {
		name: "transactions",
		fields: [
			{ name: "id", type: "string" },
			{ name: "type", type: "string", facet: true },
			{ name: "reference", type: "string" },
			{ name: "status", type: "string", facet: true },
			{ name: "amount", type: "int64", sort: true },
			{ name: "currency", type: "string", facet: true },
			{ name: "description", type: "string", optional: true },
			{ name: "source_holder_id", type: "string", optional: true },
			{ name: "destination_holder_id", type: "string", optional: true },
			{ name: "created_at", type: "int64", sort: true },
		],
	},
	identities: {
		name: "identities",
		fields: [
			{ name: "id", type: "string" },
			{ name: "holder_id", type: "string" },
			{ name: "first_name", type: "string", optional: true },
			{ name: "last_name", type: "string", optional: true },
			{ name: "email", type: "string", optional: true },
			{ name: "phone", type: "string", optional: true },
			{ name: "organization_name", type: "string", optional: true },
			{ name: "country", type: "string", facet: true, optional: true },
			{ name: "created_at", type: "int64", sort: true },
		],
	},
};

// =============================================================================
// SCHEMA
// =============================================================================

const searchSchema: Record<string, TableDefinition> = {
	search_index_queue: {
		columns: {
			id: { type: "uuid", primaryKey: true, notNull: true },
			collection: { type: "text", notNull: true },
			document_id: { type: "text", notNull: true },
			action: { type: "text", notNull: true, default: "'index'" },
			processed: { type: "boolean", notNull: true, default: "false" },
			created_at: { type: "timestamp", notNull: true, default: "NOW()" },
		},
		indexes: [
			{ name: "idx_search_queue_pending", columns: ["processed", "created_at"] },
			{ name: "idx_search_queue_collection", columns: ["collection"] },
		],
	},
	search_reindex_status: {
		columns: {
			collection: { type: "text", primaryKey: true, notNull: true },
			status: { type: "text", notNull: true, default: "'idle'" },
			total_documents: { type: "integer", notNull: true, default: "0" },
			indexed_documents: { type: "integer", notNull: true, default: "0" },
			started_at: { type: "timestamp" },
			completed_at: { type: "timestamp" },
			error_message: { type: "text" },
		},
		indexes: [],
	},
	search_documents: {
		columns: {
			id: { type: "uuid", primaryKey: true, notNull: true },
			collection: { type: "text", notNull: true },
			document_id: { type: "text", notNull: true },
			document: { type: "jsonb", notNull: true },
			tsv: { type: "tsvector", notNull: true },
			created_at: { type: "timestamp", notNull: true, default: "NOW()" },
		},
		indexes: [
			{
				name: "idx_search_documents_collection_docid",
				columns: ["collection", "document_id"],
				unique: true,
			},
			{ name: "idx_search_documents_collection", columns: ["collection"] },
		],
	},
};

// =============================================================================
// HELPERS
// =============================================================================

function json(status: number, body: unknown): PluginApiResponse {
	return { status, body };
}

function dateToTimestamp(val: string | Date | null): number {
	if (!val) return 0;
	return val instanceof Date ? val.getTime() : new Date(val).getTime();
}

// =============================================================================
// INDEXING OPERATIONS
// =============================================================================

async function queueForIndexing(
	ctx: SummaContext,
	collection: string,
	documentId: string,
	action: "index" | "delete" = "index",
): Promise<void> {
	const t = createTableResolver(ctx.options.schema);
	const d = ctx.dialect;
	await ctx.adapter.rawMutate(
		`INSERT INTO ${t("search_index_queue")} (id, collection, document_id, action, created_at)
		 VALUES (${d.generateUuid()}, $1, $2, $3, ${d.now()})`,
		[collection, documentId, action],
	);
}

async function processIndexQueue(
	ctx: SummaContext,
	backend: SearchBackend,
	batchSize: number,
	enabledCollections: Set<SearchCollection>,
): Promise<number> {
	const t = createTableResolver(ctx.options.schema);
	const _d = ctx.dialect;
	const ledgerId = getLedgerId(ctx);

	const rows = await ctx.adapter.raw<{
		id: string;
		collection: string;
		document_id: string;
		action: string;
	}>(
		`SELECT id, collection, document_id, action
		 FROM ${t("search_index_queue")}
		 WHERE processed = false
		 ORDER BY created_at ASC
		 LIMIT $1`,
		[batchSize],
	);

	if (rows.length === 0) return 0;

	let processed = 0;

	// Group by collection for batch indexing
	const groups = new Map<string, typeof rows>();
	for (const row of rows) {
		if (!enabledCollections.has(row.collection as SearchCollection)) continue;
		const group = groups.get(row.collection) ?? [];
		group.push(row);
		groups.set(row.collection, group);
	}

	for (const [collection, items] of groups) {
		const indexItems = items.filter((i) => i.action === "index");
		const deleteItems = items.filter((i) => i.action === "delete");

		// Process deletes
		for (const item of deleteItems) {
			try {
				await backend.delete(collection, item.document_id);
			} catch {
				// Ignore delete failures (document may not exist)
			}
		}

		// Process indexes - fetch documents from DB
		if (indexItems.length > 0) {
			const docIds = indexItems.map((i) => i.document_id);
			let documents: Record<string, unknown>[] = [];

			if (collection === "accounts") {
				documents = await ctx.adapter.raw(
					`SELECT id, holder_id, holder_type, currency, status, account_type,
					        account_code, balance, created_at
					 FROM ${t("account")}
					 WHERE id = ANY($1::uuid[]) AND ledger_id = $2`,
					[docIds, ledgerId],
				);
			} else if (collection === "transactions") {
				documents = await ctx.adapter.raw(
					`SELECT id, type, reference, status, amount, currency, description,
					        source_account_id, destination_account_id, created_at
					 FROM ${t("transfer")}
					 WHERE id = ANY($1::uuid[]) AND ledger_id = $2`,
					[docIds, ledgerId],
				);
			} else if (collection === "identities") {
				documents = await ctx.adapter.raw(
					`SELECT id, holder_id, first_name, last_name, email, phone,
					        organization_name, country, created_at
					 FROM ${t("identity")}
					 WHERE id = ANY($1::uuid[]) AND ledger_id = $2`,
					[docIds, ledgerId],
				);
			}

			// Convert timestamps to epoch for search backend
			const prepared = documents.map((doc) => ({
				...doc,
				created_at: dateToTimestamp(doc.created_at as string | Date | null),
			}));

			if (prepared.length > 0) {
				try {
					await backend.indexBatch(collection, prepared);
				} catch (error) {
					ctx.logger.error("Search indexing batch failed", {
						collection,
						count: prepared.length,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
		}

		processed += items.length;
	}

	// Mark all as processed
	const ids = rows.map((r) => r.id);
	await ctx.adapter.rawMutate(
		`UPDATE ${t("search_index_queue")} SET processed = true WHERE id = ANY($1::uuid[])`,
		[ids],
	);

	return processed;
}

async function startReindex(
	ctx: SummaContext,
	backend: SearchBackend,
	collection: SearchCollection,
	batchSize: number,
): Promise<void> {
	const t = createTableResolver(ctx.options.schema);
	const d = ctx.dialect;
	const ledgerId = getLedgerId(ctx);

	// Update status
	await ctx.adapter.rawMutate(
		`INSERT INTO ${t("search_reindex_status")} (collection, status, total_documents, indexed_documents, started_at)
		 VALUES ($1, 'in_progress', 0, 0, ${d.now()})
		 ${d.onConflictDoUpdate(["collection"], {
				status: "'in_progress'",
				total_documents: "0",
				indexed_documents: "0",
				started_at: d.now(),
				completed_at: "NULL",
				error_message: "NULL",
			})}`,
		[collection],
	);

	try {
		let totalIndexed = 0;
		let lastId = "";

		// Count total
		let tableName = "account";
		if (collection === "transactions") tableName = "transfer";
		if (collection === "identities") tableName = "identity";

		const countRows = await ctx.adapter.raw<{ total: number }>(
			`SELECT ${d.countAsInt()} AS total FROM ${t(tableName)} WHERE ledger_id = $1`,
			[ledgerId],
		);
		const total = countRows[0]?.total ?? 0;

		await ctx.adapter.rawMutate(
			`UPDATE ${t("search_reindex_status")} SET total_documents = $1 WHERE collection = $2`,
			[total, collection],
		);

		// Batch reindex with keyset pagination
		while (true) {
			let documents: Record<string, unknown>[];

			if (collection === "accounts") {
				documents = await ctx.adapter.raw(
					`SELECT id, holder_id, holder_type, currency, status, account_type,
					        account_code, balance, created_at
					 FROM ${t("account")}
					 WHERE ledger_id = $1 AND id > $2
					 ORDER BY id ASC LIMIT $3`,
					[ledgerId, lastId, batchSize],
				);
			} else if (collection === "transactions") {
				documents = await ctx.adapter.raw(
					`SELECT id, type, reference, status, amount, currency, description,
					        source_account_id, destination_account_id, created_at
					 FROM ${t("transfer")}
					 WHERE ledger_id = $1 AND id > $2
					 ORDER BY id ASC LIMIT $3`,
					[ledgerId, lastId, batchSize],
				);
			} else {
				documents = await ctx.adapter.raw(
					`SELECT id, holder_id, first_name, last_name, email, phone,
					        organization_name, country, created_at
					 FROM ${t("identity")}
					 WHERE ledger_id = $1 AND id > $2
					 ORDER BY id ASC LIMIT $3`,
					[ledgerId, lastId, batchSize],
				);
			}

			if (documents.length === 0) break;

			const prepared = documents.map((doc) => ({
				...doc,
				created_at: dateToTimestamp(doc.created_at as string | Date | null),
			}));

			await backend.indexBatch(collection, prepared);

			totalIndexed += documents.length;
			lastId = (documents[documents.length - 1] as { id: string }).id;

			// Update progress
			await ctx.adapter.rawMutate(
				`UPDATE ${t("search_reindex_status")} SET indexed_documents = $1 WHERE collection = $2`,
				[totalIndexed, collection],
			);

			if (documents.length < batchSize) break;
		}

		await ctx.adapter.rawMutate(
			`UPDATE ${t("search_reindex_status")}
			 SET status = 'completed', indexed_documents = $1, completed_at = ${d.now()}
			 WHERE collection = $2`,
			[totalIndexed, collection],
		);

		ctx.logger.info("Reindex completed", { collection, totalIndexed });
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		await ctx.adapter.rawMutate(
			`UPDATE ${t("search_reindex_status")}
			 SET status = 'failed', error_message = $1, completed_at = ${d.now()}
			 WHERE collection = $2`,
			[errorMsg, collection],
		);
		throw error;
	}
}

// =============================================================================
// PLUGIN FACTORY
// =============================================================================

export function search(options: SearchOptions): SummaPlugin {
	const enabledCollections = new Set<SearchCollection>(
		options.collections ?? ["accounts", "transactions"],
	);
	const batchSize = options.reindexBatchSize ?? 500;

	return {
		id: "search",

		$Infer: {} as {
			SearchResult: SearchResult;
			ReindexStatus: ReindexStatus;
		},

		schema: searchSchema,

		init: async (ctx: SummaContext) => {
			if (options.backend.setContext) {
				options.backend.setContext(ctx);
			}
			const schemas = [...enabledCollections].map((c) => COLLECTION_SCHEMAS[c]);
			await options.backend.initialize(schemas);
			ctx.logger.info("Search plugin initialized", {
				collections: [...enabledCollections],
			});
		},

		hooks: {
			afterTransaction: async (params) => {
				if (!enabledCollections.has("transactions")) return;
				// We don't have transaction ID in hook params, queue via reference lookup
				const t = createTableResolver(params.ctx.options.schema);
				const ledgerId = getLedgerId(params.ctx);
				const rows = await params.ctx.adapter.raw<{ id: string }>(
					`SELECT id FROM ${t("transfer")}
					 WHERE reference = $1 AND ledger_id = $2 LIMIT 1`,
					[params.reference, ledgerId],
				);
				if (rows[0]) {
					await queueForIndexing(params.ctx, "transactions", rows[0].id);
				}

				// Also re-index affected accounts
				if (enabledCollections.has("accounts")) {
					const holderId = params.holderId ?? params.sourceHolderId;
					if (holderId) {
						const accounts = await params.ctx.adapter.raw<{ id: string }>(
							`SELECT id FROM ${t("account")}
							 WHERE holder_id = $1 AND ledger_id = $2 LIMIT 1`,
							[holderId, ledgerId],
						);
						if (accounts[0]) {
							await queueForIndexing(params.ctx, "accounts", accounts[0].id);
						}
					}
				}
			},

			afterAccountCreate: async (params) => {
				if (!enabledCollections.has("accounts")) return;
				if (params.accountId) {
					await queueForIndexing(params.ctx, "accounts", params.accountId);
				}
			},
		},

		workers: [
			{
				id: "search-indexer",
				description: "Process search index queue",
				interval: "3s",
				leaseRequired: false,
				handler: async (ctx: SummaContext) => {
					const count = await processIndexQueue(
						ctx,
						options.backend,
						batchSize,
						enabledCollections,
					);
					if (count > 0) {
						ctx.logger.info("Search index queue processed", { count });
					}
				},
			},
			{
				id: "search-queue-cleanup",
				description: "Remove old processed search queue entries",
				interval: "6h",
				leaseRequired: true,
				handler: async (ctx: SummaContext) => {
					const t = createTableResolver(ctx.options.schema);
					const d = ctx.dialect;
					const deleted = await ctx.adapter.rawMutate(
						`DELETE FROM ${t("search_index_queue")}
						 WHERE processed = true
						   AND created_at < ${d.now()} - ${d.interval("24 hour")}`,
						[],
					);
					if (deleted > 0) {
						ctx.logger.info("Cleaned up search index queue", { count: deleted });
					}
				},
			},
		],

		endpoints: [
			// POST /search/:collection -- Search a collection
			{
				method: "POST",
				path: "/search/:collection",
				handler: async (req: PluginApiRequest, _ctx: SummaContext) => {
					const collection = req.params.collection as SearchCollection;
					if (!enabledCollections.has(collection))
						return json(400, {
							error: {
								code: "INVALID_ARGUMENT",
								message: `Collection "${collection}" not enabled`,
							},
						});

					const body = req.body as SearchQuery | null;
					if (!body?.q)
						return json(400, {
							error: { code: "INVALID_ARGUMENT", message: "q (query) is required" },
						});

					const result = await options.backend.search(collection, body);
					return json(200, result);
				},
			},

			// POST /search/multi -- Multi-collection search
			{
				method: "POST",
				path: "/search/multi",
				handler: async (req: PluginApiRequest, _ctx: SummaContext) => {
					const body = req.body as {
						queries?: Array<{ collection: string; query: SearchQuery }>;
					} | null;

					if (!body?.queries?.length)
						return json(400, {
							error: { code: "INVALID_ARGUMENT", message: "queries array required" },
						});

					if (options.backend.multiSearch) {
						const results = await options.backend.multiSearch(body.queries);
						return json(200, { results });
					}

					// Fallback: sequential search
					const results = await Promise.all(
						body.queries.map((q) => options.backend.search(q.collection, q.query)),
					);
					return json(200, { results });
				},
			},

			// POST /search/reindex -- Start reindex
			{
				method: "POST",
				path: "/search/reindex",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const body = req.body as { collection?: SearchCollection } | null;
					const collection = body?.collection;

					if (!collection || !enabledCollections.has(collection))
						return json(400, {
							error: {
								code: "INVALID_ARGUMENT",
								message: `collection must be one of: ${[...enabledCollections].join(", ")}`,
							},
						});

					// Start reindex in background (non-blocking)
					startReindex(ctx, options.backend, collection, batchSize).catch((err) => {
						ctx.logger.error("Reindex failed", {
							collection,
							error: err instanceof Error ? err.message : String(err),
						});
					});

					return json(202, { message: `Reindex started for ${collection}` });
				},
			},

			// GET /search/reindex/status -- Get reindex status
			{
				method: "GET",
				path: "/search/reindex/status",
				handler: async (_req: PluginApiRequest, ctx: SummaContext) => {
					const t = createTableResolver(ctx.options.schema);
					const rows = await ctx.adapter.raw<{
						collection: string;
						status: string;
						total_documents: number;
						indexed_documents: number;
						started_at: string | Date | null;
						completed_at: string | Date | null;
						error_message: string | null;
					}>(`SELECT * FROM ${t("search_reindex_status")} ORDER BY collection`, []);

					const statuses: ReindexStatus[] = rows.map((r) => ({
						collection: r.collection,
						status: r.status as ReindexStatus["status"],
						totalDocuments: Number(r.total_documents),
						indexedDocuments: Number(r.indexed_documents),
						startedAt: r.started_at
							? r.started_at instanceof Date
								? r.started_at.toISOString()
								: String(r.started_at)
							: null,
						completedAt: r.completed_at
							? r.completed_at instanceof Date
								? r.completed_at.toISOString()
								: String(r.completed_at)
							: null,
						errorMessage: r.error_message,
					}));

					return json(200, { statuses });
				},
			},
		],
	};
}

// =============================================================================
// TYPESENSE BACKEND
// =============================================================================

export interface TypesenseConfig {
	host: string;
	port: number;
	protocol?: "http" | "https";
	apiKey: string;
}

export function typesenseBackend(config: TypesenseConfig): SearchBackend {
	const baseUrl = `${config.protocol ?? "http"}://${config.host}:${config.port}`;
	const headers = {
		"Content-Type": "application/json",
		"X-TYPESENSE-API-KEY": config.apiKey,
	};

	return {
		initialize: async (collections) => {
			for (const col of collections) {
				try {
					await fetch(`${baseUrl}/collections`, {
						method: "POST",
						headers,
						body: JSON.stringify({
							name: col.name,
							fields: col.fields.map((f) => ({
								name: f.name,
								type: f.type,
								facet: f.facet ?? false,
								index: f.index ?? true,
								optional: f.optional ?? false,
								sort: f.sort ?? false,
							})),
						}),
					});
				} catch {
					// Collection may already exist
				}
			}
		},

		index: async (collection, document) => {
			await fetch(`${baseUrl}/collections/${collection}/documents`, {
				method: "POST",
				headers,
				body: JSON.stringify(document),
			});
		},

		indexBatch: async (collection, documents) => {
			const jsonl = documents.map((d) => JSON.stringify(d)).join("\n");
			await fetch(`${baseUrl}/collections/${collection}/documents/import?action=upsert`, {
				method: "POST",
				headers: { ...headers, "Content-Type": "text/plain" },
				body: jsonl,
			});
		},

		search: async (collection, query) => {
			const params = new URLSearchParams({
				q: query.q,
				query_by: (query.queryBy ?? ["*"]).join(","),
				page: String(query.page ?? 1),
				per_page: String(query.perPage ?? 20),
			});

			if (query.filterBy) params.set("filter_by", query.filterBy);
			if (query.sortBy) params.set("sort_by", query.sortBy);
			if (query.facetBy?.length) params.set("facet_by", query.facetBy.join(","));

			const res = await fetch(`${baseUrl}/collections/${collection}/documents/search?${params}`, {
				headers,
			});

			const data = (await res.json()) as {
				hits?: Array<{ document: Record<string, unknown>; highlights?: unknown[] }>;
				found?: number;
				page?: number;
			};

			return {
				hits: (data.hits ?? []).map((h) => ({
					document: h.document,
					highlights: [],
				})),
				found: data.found ?? 0,
				page: data.page ?? 1,
				totalPages: Math.ceil((data.found ?? 0) / (query.perPage ?? 20)),
			};
		},

		delete: async (collection, documentId) => {
			await fetch(`${baseUrl}/collections/${collection}/documents/${documentId}`, {
				method: "DELETE",
				headers,
			});
		},

		multiSearch: async (queries) => {
			const body = {
				searches: queries.map((q) => ({
					collection: q.collection,
					q: q.query.q,
					query_by: (q.query.queryBy ?? ["*"]).join(","),
					page: String(q.query.page ?? 1),
					per_page: String(q.query.perPage ?? 20),
				})),
			};

			const res = await fetch(`${baseUrl}/multi_search`, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
			});

			const data = (await res.json()) as {
				results?: Array<{
					hits?: Array<{ document: Record<string, unknown> }>;
					found?: number;
					page?: number;
				}>;
			};

			return (data.results ?? []).map((r) => ({
				hits: (r.hits ?? []).map((h) => ({ document: h.document })),
				found: r.found ?? 0,
				page: r.page ?? 1,
				totalPages: 1,
			}));
		},
	};
}

// =============================================================================
// MEILISEARCH BACKEND
// =============================================================================

export interface MeilisearchConfig {
	host: string;
	apiKey: string;
}

export function meilisearchBackend(config: MeilisearchConfig): SearchBackend {
	const headers = {
		"Content-Type": "application/json",
		Authorization: `Bearer ${config.apiKey}`,
	};

	return {
		initialize: async (collections) => {
			for (const col of collections) {
				try {
					await fetch(`${config.host}/indexes`, {
						method: "POST",
						headers,
						body: JSON.stringify({ uid: col.name, primaryKey: "id" }),
					});

					// Set filterable and sortable attributes
					const filterableFields = col.fields.filter((f) => f.facet).map((f) => f.name);
					const sortableFields = col.fields.filter((f) => f.sort).map((f) => f.name);

					if (filterableFields.length > 0) {
						await fetch(`${config.host}/indexes/${col.name}/settings/filterable-attributes`, {
							method: "PUT",
							headers,
							body: JSON.stringify(filterableFields),
						});
					}

					if (sortableFields.length > 0) {
						await fetch(`${config.host}/indexes/${col.name}/settings/sortable-attributes`, {
							method: "PUT",
							headers,
							body: JSON.stringify(sortableFields),
						});
					}
				} catch {
					// Index may already exist
				}
			}
		},

		index: async (collection, document) => {
			await fetch(`${config.host}/indexes/${collection}/documents`, {
				method: "POST",
				headers,
				body: JSON.stringify([document]),
			});
		},

		indexBatch: async (collection, documents) => {
			await fetch(`${config.host}/indexes/${collection}/documents`, {
				method: "POST",
				headers,
				body: JSON.stringify(documents),
			});
		},

		search: async (collection, query) => {
			const res = await fetch(`${config.host}/indexes/${collection}/search`, {
				method: "POST",
				headers,
				body: JSON.stringify({
					q: query.q,
					limit: query.perPage ?? 20,
					offset: ((query.page ?? 1) - 1) * (query.perPage ?? 20),
					filter: query.filterBy,
					sort: query.sortBy ? [query.sortBy] : undefined,
					facets: query.facetBy,
				}),
			});

			const data = (await res.json()) as {
				hits?: Record<string, unknown>[];
				estimatedTotalHits?: number;
			};

			return {
				hits: (data.hits ?? []).map((doc) => ({ document: doc })),
				found: data.estimatedTotalHits ?? 0,
				page: query.page ?? 1,
				totalPages: Math.ceil((data.estimatedTotalHits ?? 0) / (query.perPage ?? 20)),
			};
		},

		delete: async (collection, documentId) => {
			await fetch(`${config.host}/indexes/${collection}/documents/${documentId}`, {
				method: "DELETE",
				headers,
			});
		},
	};
}

// =============================================================================
// POSTGRESQL NATIVE BACKEND
// =============================================================================
// Zero-dependency full-text search using PostgreSQL tsvector + GIN indexes.
// No external services required — ideal for small-to-medium deployments.

export interface PgSearchConfig {
	/** PostgreSQL text search configuration. Default: "english" */
	language?: string;
	/** Enable pg_trgm trigram indexes for fuzzy search fallback. Default: false */
	enableTrigram?: boolean;
	/** Similarity threshold for trigram matching (0.0-1.0). Default: 0.3 */
	trigramThreshold?: number;
	/** Create partial indexes for common filter patterns. */
	partialIndexes?: Array<{
		collection: string;
		field: string;
	}>;
	/** Document count threshold to recommend switching to external search. Default: 5_000_000 */
	externalSearchThreshold?: number;
}

interface ParsedFilter {
	field: string;
	op: string;
	value: string;
}

function buildSearchText(doc: Record<string, unknown>): string {
	return Object.values(doc)
		.filter((v): v is string => typeof v === "string")
		.join(" ");
}

function parseFilterBy(filterBy: string): ParsedFilter[] {
	const parts = filterBy
		.split("&&")
		.map((s) => s.trim())
		.filter(Boolean);
	return parts.map((part) => {
		const match = part.match(/^(\w+)\s*(:=|:!=|:>=|:<=|:>|:<)\s*(.+)$/);
		if (!match) throw new SummaError("INVALID_ARGUMENT", `Invalid filter expression: ${part}`);
		const [, field, op, value] = match as [string, string, string, string];
		return { field, op, value };
	});
}

function filterToSql(
	filters: ParsedFilter[],
	startIdx: number,
	ph: (i: number) => string,
): { clause: string; params: unknown[] } {
	const conditions: string[] = [];
	const params: unknown[] = [];
	let idx = startIdx;

	for (const f of filters) {
		switch (f.op) {
			case ":=":
				conditions.push(`document->>${ph(idx)} = ${ph(idx + 1)}`);
				params.push(f.field, f.value);
				idx += 2;
				break;
			case ":!=":
				conditions.push(`document->>${ph(idx)} != ${ph(idx + 1)}`);
				params.push(f.field, f.value);
				idx += 2;
				break;
			case ":>":
				conditions.push(`(document->>${ph(idx)})::numeric > ${ph(idx + 1)}::numeric`);
				params.push(f.field, f.value);
				idx += 2;
				break;
			case ":<":
				conditions.push(`(document->>${ph(idx)})::numeric < ${ph(idx + 1)}::numeric`);
				params.push(f.field, f.value);
				idx += 2;
				break;
			case ":>=":
				conditions.push(`(document->>${ph(idx)})::numeric >= ${ph(idx + 1)}::numeric`);
				params.push(f.field, f.value);
				idx += 2;
				break;
			case ":<=":
				conditions.push(`(document->>${ph(idx)})::numeric <= ${ph(idx + 1)}::numeric`);
				params.push(f.field, f.value);
				idx += 2;
				break;
		}
	}

	return { clause: conditions.length > 0 ? ` AND ${conditions.join(" AND ")}` : "", params };
}

function parseSortBy(sortBy: string): { field: string; direction: "ASC" | "DESC" } {
	const [field, dir] = sortBy.split(":");
	return {
		field: field ?? sortBy,
		direction: dir?.toLowerCase() === "asc" ? "ASC" : "DESC",
	};
}

export function pgSearchBackend(config?: PgSearchConfig): SearchBackend {
	const language = config?.language ?? "english";
	let ctx: SummaContext | null = null;

	function getCtx(): SummaContext {
		if (!ctx)
			throw new SummaError("INTERNAL", "pgSearchBackend: setContext() must be called before use");
		return ctx;
	}

	const backend: SearchBackend = {
		setContext(c: SummaContext) {
			ctx = c;
		},

		initialize: async () => {
			const c = getCtx();
			if (c.dialect.name !== "postgres") {
				throw new SummaError("INTERNAL", "pgSearchBackend requires PostgreSQL");
			}
			const t = createTableResolver(c.options.schema);
			// Create GIN index on tsvector column (not expressible in TableDefinition)
			await c.adapter.rawMutate(
				`CREATE INDEX IF NOT EXISTS idx_search_documents_tsv ON ${t("search_documents")} USING gin (tsv)`,
				[],
			);

			// Trigram extension and index for fuzzy search fallback
			if (config?.enableTrigram) {
				try {
					await c.adapter.rawMutate(`CREATE EXTENSION IF NOT EXISTS pg_trgm`, []);
					await c.adapter.rawMutate(
						`CREATE INDEX IF NOT EXISTS idx_search_documents_trgm ON ${t("search_documents")} USING gin (
							((document->>'holder_id') || ' ' || COALESCE(document->>'reference', '') || ' ' || COALESCE(document->>'description', ''))
							gin_trgm_ops
						)`,
						[],
					);
					c.logger.info("pg_trgm trigram index created for fuzzy search");
				} catch (err) {
					c.logger.warn("Failed to create trigram index — pg_trgm extension may not be available", {
						error: err instanceof Error ? err.message : String(err),
					});
				}
			}

			// Partial indexes for common filter patterns
			if (config?.partialIndexes) {
				for (const pi of config.partialIndexes) {
					const indexName = `idx_search_partial_${pi.collection}_${pi.field}`;
					try {
						await c.adapter.rawMutate(
							`CREATE INDEX IF NOT EXISTS ${indexName}
							 ON ${t("search_documents")} ((document->>'${pi.field}'))
							 WHERE collection = '${pi.collection}'`,
							[],
						);
					} catch (err) {
						c.logger.warn("Failed to create partial index", {
							index: indexName,
							error: err instanceof Error ? err.message : String(err),
						});
					}
				}
			}
		},

		index: async (collection, document) => {
			const c = getCtx();
			const t = createTableResolver(c.options.schema);
			const d = c.dialect;
			const docId = String(document.id ?? "");
			const text = buildSearchText(document);

			await c.adapter.rawMutate(
				`INSERT INTO ${t("search_documents")} (id, collection, document_id, document, tsv, created_at)
				 VALUES (${d.generateUuid()}, ${d.paramPlaceholder(1)}, ${d.paramPlaceholder(2)}, ${d.paramPlaceholder(3)}::jsonb, to_tsvector(${d.paramPlaceholder(4)}, ${d.paramPlaceholder(5)}), ${d.now()})
				 ${d.onConflictDoUpdate(["collection", "document_id"], {
						document: `${d.paramPlaceholder(3)}::jsonb`,
						tsv: `to_tsvector(${d.paramPlaceholder(4)}, ${d.paramPlaceholder(5)})`,
					})}`,
				[collection, docId, JSON.stringify(document), language, text],
			);
		},

		indexBatch: async (collection, documents) => {
			if (documents.length === 0) return;
			const c = getCtx();
			const t = createTableResolver(c.options.schema);
			const d = c.dialect;

			// Build per-row values for batch insert
			const valueParts: string[] = [];
			const params: unknown[] = [];
			let idx = 1;

			for (const doc of documents) {
				const docId = String(doc.id ?? "");
				const text = buildSearchText(doc);
				valueParts.push(
					`(${d.generateUuid()}, ${d.paramPlaceholder(idx)}, ${d.paramPlaceholder(idx + 1)}, ${d.paramPlaceholder(idx + 2)}::jsonb, to_tsvector(${d.paramPlaceholder(idx + 3)}, ${d.paramPlaceholder(idx + 4)}), ${d.now()})`,
				);
				params.push(collection, docId, JSON.stringify(doc), language, text);
				idx += 5;
			}

			await c.adapter.rawMutate(
				`INSERT INTO ${t("search_documents")} (id, collection, document_id, document, tsv, created_at)
				 VALUES ${valueParts.join(", ")}
				 ${d.onConflictDoUpdate(["collection", "document_id"], {
						document: "EXCLUDED.document",
						tsv: "EXCLUDED.tsv",
						created_at: "EXCLUDED.created_at",
					})}`,
				params,
			);
		},

		search: async (collection, query) => {
			const c = getCtx();
			const t = createTableResolver(c.options.schema);
			const d = c.dialect;
			const perPage = query.perPage ?? 20;
			const page = query.page ?? 1;
			const offset = (page - 1) * perPage;

			const isWildcard = !query.q || query.q.trim() === "*" || query.q.trim() === "";

			// Build WHERE clause
			let paramIdx = 1;
			const whereParts: string[] = [`collection = ${d.paramPlaceholder(paramIdx)}`];
			const params: unknown[] = [collection];
			paramIdx++;

			let scoreExpr = "1";
			if (!isWildcard) {
				if (config?.enableTrigram) {
					// Try tsvector first; if zero results, fall back to trigram similarity
					const tsvCountRows = await c.readAdapter.raw<{ cnt: number }>(
						`SELECT COUNT(*)::int AS cnt FROM ${t("search_documents")}
						 WHERE collection = ${d.paramPlaceholder(1)} AND tsv @@ plainto_tsquery(${d.paramPlaceholder(2)}, ${d.paramPlaceholder(3)})`,
						[collection, language, query.q],
					);
					const tsvCount = tsvCountRows[0]?.cnt ?? 0;

					if (tsvCount === 0) {
						// Fallback to trigram similarity
						const threshold = config.trigramThreshold ?? 0.3;
						const trigramExpr = `((document->>'holder_id') || ' ' || COALESCE(document->>'reference', '') || ' ' || COALESCE(document->>'description', ''))`;
						whereParts.push(
							`similarity(${trigramExpr}, ${d.paramPlaceholder(paramIdx)}) > ${threshold}`,
						);
						scoreExpr = `similarity(${trigramExpr}, ${d.paramPlaceholder(paramIdx)})`;
						params.push(query.q);
						paramIdx++;
						c.logger.debug("Search fell back to trigram similarity", {
							collection,
							query: query.q,
						});
					} else {
						whereParts.push(
							`tsv @@ plainto_tsquery(${d.paramPlaceholder(paramIdx)}, ${d.paramPlaceholder(paramIdx + 1)})`,
						);
						scoreExpr = `ts_rank(tsv, plainto_tsquery(${d.paramPlaceholder(paramIdx)}, ${d.paramPlaceholder(paramIdx + 1)}))`;
						params.push(language, query.q);
						paramIdx += 2;
					}
				} else {
					whereParts.push(
						`tsv @@ plainto_tsquery(${d.paramPlaceholder(paramIdx)}, ${d.paramPlaceholder(paramIdx + 1)})`,
					);
					scoreExpr = `ts_rank(tsv, plainto_tsquery(${d.paramPlaceholder(paramIdx)}, ${d.paramPlaceholder(paramIdx + 1)}))`;
					params.push(language, query.q);
					paramIdx += 2;
				}
			}

			// Apply filters
			if (query.filterBy) {
				const filters = parseFilterBy(query.filterBy);
				const { clause, params: filterParams } = filterToSql(
					filters,
					paramIdx,
					d.paramPlaceholder.bind(d),
				);
				whereParts.push(clause.replace(/^ AND /, ""));
				params.push(...filterParams);
				paramIdx += filterParams.length;
			}

			const whereClause = whereParts.join(" AND ");

			// Sort
			let orderBy = `${scoreExpr} DESC`;
			if (query.sortBy) {
				const { field, direction } = parseSortBy(query.sortBy);
				orderBy = `(document->>'${field}') ${direction}`;
			}

			// Count total (read-only — use replica)
			const countRows = await c.readAdapter.raw<{ total: number }>(
				`SELECT ${d.countAsInt()} AS total FROM ${t("search_documents")} WHERE ${whereClause}`,
				params,
			);
			const total = countRows[0]?.total ?? 0;

			// Fetch page (read-only — use replica)
			const rows = await c.readAdapter.raw<{
				document: Record<string, unknown> | string;
				score: number;
			}>(
				`SELECT document, ${scoreExpr} AS score
				 FROM ${t("search_documents")}
				 WHERE ${whereClause}
				 ORDER BY ${orderBy}
				 LIMIT ${d.paramPlaceholder(paramIdx)} OFFSET ${d.paramPlaceholder(paramIdx + 1)}`,
				[...params, perPage, offset],
			);

			const hits: SearchHit[] = rows.map((r) => ({
				document:
					typeof r.document === "string"
						? (JSON.parse(r.document) as Record<string, unknown>)
						: r.document,
				score: r.score,
			}));

			// Facets
			let facetCounts: Record<string, Array<{ value: string; count: number }>> | undefined;
			if (query.facetBy?.length) {
				facetCounts = {};
				for (const facetField of query.facetBy) {
					const facetRows = await c.readAdapter.raw<{ value: string; count: number }>(
						`SELECT document->>${d.paramPlaceholder(paramIdx + 2)} AS value, ${d.countAsInt()} AS count
						 FROM ${t("search_documents")}
						 WHERE ${whereClause}
						 GROUP BY document->>${d.paramPlaceholder(paramIdx + 2)}
						 ORDER BY count DESC
						 LIMIT 50`,
						[...params, perPage, offset, facetField],
					);
					facetCounts[facetField] = facetRows.map((r) => ({
						value: String(r.value ?? ""),
						count: Number(r.count),
					}));
				}
			}

			return {
				hits,
				found: total,
				page,
				totalPages: Math.ceil(total / perPage),
				facetCounts,
			};
		},

		delete: async (collection, documentId) => {
			const c = getCtx();
			const t = createTableResolver(c.options.schema);
			const d = c.dialect;
			await c.adapter.rawMutate(
				`DELETE FROM ${t("search_documents")} WHERE collection = ${d.paramPlaceholder(1)} AND document_id = ${d.paramPlaceholder(2)}`,
				[collection, documentId],
			);
		},

		multiSearch: async (queries) => {
			return Promise.all(queries.map((q) => backend.search(q.collection, q.query)));
		},
	};

	return backend;
}
