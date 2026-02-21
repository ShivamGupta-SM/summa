// =============================================================================
// BATCH IMPORT PLUGIN -- Bulk transaction import via CSV/JSON
// =============================================================================
// Stage -> Validate -> Post workflow for bulk transaction upload.
// Status tracking uses entity_status_log (append-only) instead of mutable columns.

import type {
	LedgerTransaction,
	PluginApiRequest,
	PluginApiResponse,
	SummaContext,
	SummaPlugin,
} from "@summa/core";
import { SummaError } from "@summa/core";
import { createTableResolver } from "@summa/core/db";
import {
	initializeEntityStatus,
	transitionEntityStatus,
} from "../../infrastructure/entity-status.js";
import { creditAccount, debitAccount, transfer } from "../managers/transaction-manager.js";

// =============================================================================
// TYPES
// =============================================================================

export interface BatchImportOptions {
	/** Maximum items per batch. Default: 10000 */
	maxBatchSize?: number;
	/** Column mapping for CSV import. Default: standard columns */
	csvColumnMapping?: Record<string, string>;
}

export type BatchStatus =
	| "staged"
	| "validating"
	| "validated"
	| "posting"
	| "posted"
	| "partial"
	| "failed";

export interface ImportBatch {
	id: string;
	name: string;
	format: "csv" | "json";
	status: BatchStatus;
	totalItems: number;
	validItems: number;
	invalidItems: number;
	postedItems: number;
	failedItems: number;
	createdBy: string | null;
	createdAt: string;
	postedAt: string | null;
}

export interface BatchItem {
	id: string;
	batchId: string;
	lineNumber: number;
	rawData: Record<string, unknown>;
	parsedData: Record<string, unknown> | null;
	status: "pending" | "valid" | "invalid" | "posted" | "failed";
	errorMessage: string | null;
	transactionId: string | null;
	createdAt: string;
}

/** Raw row from import_batch table (immutable columns only) */
interface RawBatchRow {
	id: string;
	name: string;
	format: string;
	total_items: number;
	created_by: string | null;
	created_at: string | Date;
}

/** Status + metadata fields resolved from entity_status_log via LATERAL JOIN */
interface RawBatchWithStatusRow extends RawBatchRow {
	current_status: string;
	status_metadata: Record<string, unknown> | null;
}

/** Raw row from batch_item table (immutable columns only) */
interface RawItemRow {
	id: string;
	batch_id: string;
	line_number: number;
	raw_data: Record<string, unknown>;
	created_at: string | Date;
}

/** Item row with status + metadata fields resolved from entity_status_log via LATERAL JOIN */
interface RawItemWithStatusRow extends RawItemRow {
	current_status: string;
	status_metadata: Record<string, unknown> | null;
}

// =============================================================================
// HELPERS
// =============================================================================

function rawToBatch(row: RawBatchWithStatusRow): ImportBatch {
	const meta = row.status_metadata ?? {};
	return {
		id: row.id,
		name: row.name,
		format: row.format as "csv" | "json",
		status: row.current_status as BatchStatus,
		totalItems: Number(row.total_items),
		validItems: Number(meta.valid_items ?? 0),
		invalidItems: Number(meta.invalid_items ?? 0),
		postedItems: Number(meta.posted_items ?? 0),
		failedItems: Number(meta.failed_items ?? 0),
		createdBy: row.created_by,
		createdAt:
			row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
		postedAt: meta.posted_at != null ? String(meta.posted_at) : null,
	};
}

function _rawToItem(row: RawItemWithStatusRow): BatchItem {
	const meta = row.status_metadata ?? {};
	return {
		id: row.id,
		batchId: row.batch_id,
		lineNumber: row.line_number,
		rawData: row.raw_data,
		parsedData: (meta.parsed_data as Record<string, unknown> | null) ?? null,
		status: row.current_status as BatchItem["status"],
		errorMessage: (meta.error_message as string | null) ?? null,
		transactionId: (meta.transaction_id as string | null) ?? null,
		createdAt:
			row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
	};
}

function jsonRes(status: number, body: unknown): PluginApiResponse {
	return { status, body };
}

/** Parse a CSV string into an array of objects using header row as keys */
function parseCsv(
	csvText: string,
	columnMapping?: Record<string, string>,
): Record<string, unknown>[] {
	const lines = csvText.trim().split("\n");
	if (lines.length < 2) return [];

	const headerLine = lines[0];
	if (!headerLine) return [];
	const headers = headerLine.split(",").map((h) => h.trim());

	const results: Record<string, unknown>[] = [];
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i];
		if (!line) continue;
		const values = line.split(",").map((v) => v.trim());
		const obj: Record<string, unknown> = {};
		for (let j = 0; j < headers.length; j++) {
			const header = headers[j];
			if (!header) continue;
			const mappedKey = columnMapping?.[header] ?? header;
			obj[mappedKey] = values[j] ?? null;
		}
		results.push(obj);
	}
	return results;
}

/**
 * Build a LATERAL JOIN clause that fetches the latest entity_status_log row
 * for a given entity type, keyed to a table alias column.
 */
function statusLateralJoin(
	t: (name: string) => string,
	entityType: string,
	tableAlias: string,
	statusAlias: string,
): string {
	return `LATERAL (
    SELECT esl.status AS current_status, esl.metadata AS status_metadata
    FROM ${t("entity_status_log")} esl
    WHERE esl.entity_type = '${entityType}'
      AND esl.entity_id = ${tableAlias}.id
    ORDER BY esl.created_at DESC
    LIMIT 1
  ) ${statusAlias} ON true`;
}

// =============================================================================
// CORE OPERATIONS
// =============================================================================

export async function createBatch(
	ctx: SummaContext,
	params: {
		name: string;
		format: "csv" | "json";
		data: string | Record<string, unknown>[];
		createdBy?: string;
	},
	options?: BatchImportOptions,
): Promise<ImportBatch> {
	const t = createTableResolver(ctx.options.schema);
	let items: Record<string, unknown>[];

	if (params.format === "csv") {
		if (typeof params.data !== "string") {
			throw SummaError.invalidArgument("CSV data must be a string");
		}
		items = parseCsv(params.data, options?.csvColumnMapping);
	} else {
		items = Array.isArray(params.data)
			? params.data
			: typeof params.data === "string"
				? (JSON.parse(params.data) as Record<string, unknown>[])
				: [];
	}

	const maxSize = options?.maxBatchSize ?? 10000;
	if (items.length > maxSize) {
		throw SummaError.invalidArgument(
			`Batch exceeds maximum size of ${maxSize} items (got ${items.length})`,
		);
	}
	if (items.length === 0) {
		throw SummaError.invalidArgument("Batch contains no items");
	}

	// Insert batch record (no status or mutable counter columns)
	const batchRows = await ctx.adapter.raw<RawBatchRow>(
		`INSERT INTO ${t("import_batch")} (name, format, total_items, created_by)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
		[params.name, params.format, items.length, params.createdBy ?? null],
	);
	const batch = batchRows[0];
	if (!batch) throw SummaError.internal("Failed to create import batch");

	// Initialize batch status in entity_status_log
	await initializeEntityStatus(ctx.adapter, "import_batch", batch.id, "staged");

	// Insert batch items (no status column)
	for (let i = 0; i < items.length; i++) {
		await ctx.adapter.raw(
			`INSERT INTO ${t("batch_item")} (batch_id, line_number, raw_data)
       VALUES ($1, $2, $3::jsonb)`,
			[batch.id, i + 1, JSON.stringify(items[i])],
		);
	}

	// Initialize each item's status in entity_status_log
	const itemRows = await ctx.adapter.raw<{ id: string }>(
		`SELECT id FROM ${t("batch_item")} WHERE batch_id = $1 ORDER BY line_number`,
		[batch.id],
	);
	for (const item of itemRows) {
		await initializeEntityStatus(ctx.adapter, "batch_item", item.id, "pending");
	}

	// Return the batch with status info
	return {
		id: batch.id,
		name: batch.name,
		format: batch.format as "csv" | "json",
		status: "staged",
		totalItems: Number(batch.total_items),
		validItems: 0,
		invalidItems: 0,
		postedItems: 0,
		failedItems: 0,
		createdBy: batch.created_by,
		createdAt:
			batch.created_at instanceof Date ? batch.created_at.toISOString() : String(batch.created_at),
		postedAt: null,
	};
}

export async function listBatches(
	ctx: SummaContext,
	params?: { status?: BatchStatus; page?: number; perPage?: number },
): Promise<{ batches: ImportBatch[]; hasMore: boolean; total: number }> {
	const t = createTableResolver(ctx.options.schema);
	const page = Math.max(1, params?.page ?? 1);
	const perPage = Math.min(params?.perPage ?? 20, 100);
	const offset = (page - 1) * perPage;

	const lateralJoin = statusLateralJoin(t, "import_batch", "b", "s");
	const conditions: string[] = [];
	const queryParams: unknown[] = [];
	let paramIdx = 1;

	if (params?.status) {
		conditions.push(`s.current_status = $${paramIdx++}`);
		queryParams.push(params.status);
	}

	const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
	const countParams = [...queryParams];

	queryParams.push(perPage + 1, offset);

	const [rows, countRows] = await Promise.all([
		ctx.adapter.raw<RawBatchWithStatusRow>(
			`SELECT b.*, s.current_status, s.status_metadata
       FROM ${t("import_batch")} b
       JOIN ${lateralJoin}
       ${whereClause}
       ORDER BY b.created_at DESC
       LIMIT $${paramIdx++} OFFSET $${paramIdx}`,
			queryParams,
		),
		ctx.adapter.raw<{ total: number }>(
			`SELECT COUNT(*)::int as total
       FROM ${t("import_batch")} b
       JOIN ${lateralJoin}
       ${whereClause}`,
			countParams,
		),
	]);

	const hasMore = rows.length > perPage;
	const batches = (hasMore ? rows.slice(0, perPage) : rows).map(rawToBatch);
	return { batches, hasMore, total: countRows[0]?.total ?? 0 };
}

export async function getBatchStatus(ctx: SummaContext, batchId: string): Promise<ImportBatch> {
	const t = createTableResolver(ctx.options.schema);
	const lateralJoin = statusLateralJoin(t, "import_batch", "b", "s");
	const rows = await ctx.adapter.raw<RawBatchWithStatusRow>(
		`SELECT b.*, s.current_status, s.status_metadata
     FROM ${t("import_batch")} b
     JOIN ${lateralJoin}
     WHERE b.id = $1`,
		[batchId],
	);
	const row = rows[0];
	if (!row) throw SummaError.notFound("Batch not found");
	return rawToBatch(row);
}

export async function validateBatch(ctx: SummaContext, batchId: string): Promise<ImportBatch> {
	const t = createTableResolver(ctx.options.schema);
	// Only allow validation from 'staged' status
	const batch = await getBatchStatus(ctx, batchId);
	if (batch.status !== "staged") {
		throw SummaError.conflict(
			`Batch must be in staged status to validate (current: ${batch.status})`,
		);
	}
	// Transition batch status to validating
	await transitionEntityStatus({
		tx: ctx.adapter,
		entityType: "import_batch",
		entityId: batchId,
		status: "validating",
		expectedCurrentStatus: "staged",
	});

	const lateralJoin = statusLateralJoin(t, "batch_item", "bi", "s");
	const itemRows = await ctx.adapter.raw<RawItemWithStatusRow>(
		`SELECT bi.*, s.current_status, s.status_metadata
     FROM ${t("batch_item")} bi
     JOIN ${lateralJoin}
     WHERE bi.batch_id = $1
     ORDER BY bi.line_number`,
		[batchId],
	);

	let validCount = 0;
	let invalidCount = 0;

	for (const item of itemRows) {
		const data = item.raw_data;
		const errors: string[] = [];

		// Basic validations
		if (!data.amount || Number(data.amount) <= 0) {
			errors.push("Valid positive amount required");
		}
		if (!data.reference) {
			errors.push("reference required");
		}
		if (!data.type || !["credit", "debit", "transfer"].includes(String(data.type))) {
			errors.push("type must be credit, debit, or transfer");
		}
		// Per-type field validation
		const txnType = String(data.type);
		if (txnType === "credit" || txnType === "debit") {
			if (!data.holderId) errors.push("holderId required for credit/debit");
		}
		if (txnType === "transfer") {
			if (!data.sourceHolderId) errors.push("sourceHolderId required for transfers");
			if (!data.destinationHolderId) errors.push("destinationHolderId required for transfers");
		}

		if (errors.length > 0) {
			await transitionEntityStatus({
				tx: ctx.adapter,
				entityType: "batch_item",
				entityId: item.id,
				status: "invalid",
				expectedCurrentStatus: "pending",
				metadata: { parsed_data: data, error_message: errors.join("; ") },
			});
			invalidCount++;
		} else {
			await transitionEntityStatus({
				tx: ctx.adapter,
				entityType: "batch_item",
				entityId: item.id,
				status: "valid",
				expectedCurrentStatus: "pending",
				metadata: { parsed_data: data },
			});
			validCount++;
		}
	}

	// Transition batch to validated, storing counts in metadata
	await transitionEntityStatus({
		tx: ctx.adapter,
		entityType: "import_batch",
		entityId: batchId,
		status: "validated",
		expectedCurrentStatus: "validating",
		metadata: { valid_items: validCount, invalid_items: invalidCount },
	});

	return getBatchStatus(ctx, batchId);
}

export async function postBatch(
	ctx: SummaContext,
	params: { batchId: string; mode?: "all_or_nothing" | "continue_on_error" },
): Promise<ImportBatch> {
	const t = createTableResolver(ctx.options.schema);
	const mode = params.mode ?? "continue_on_error";
	const batch = await getBatchStatus(ctx, params.batchId);

	if (batch.status !== "validated") {
		throw SummaError.conflict(`Batch must be validated before posting (current: ${batch.status})`);
	}

	// Transition batch status to posting
	await transitionEntityStatus({
		tx: ctx.adapter,
		entityType: "import_batch",
		entityId: params.batchId,
		status: "posting",
		expectedCurrentStatus: "validated",
	});

	const lateralJoin = statusLateralJoin(t, "batch_item", "bi", "s");
	const validItems = await ctx.adapter.raw<RawItemWithStatusRow>(
		`SELECT bi.*, s.current_status, s.status_metadata
     FROM ${t("batch_item")} bi
     JOIN ${lateralJoin}
     WHERE bi.batch_id = $1 AND s.current_status = 'valid'
     ORDER BY bi.line_number`,
		[params.batchId],
	);

	let postedCount = 0;
	let failedCount = 0;

	for (const item of validItems) {
		try {
			const meta = item.status_metadata ?? {};
			const data = (meta.parsed_data as Record<string, unknown>) ?? item.raw_data;
			const txnResult = await executeBatchItem(ctx, data, params.batchId, item.line_number);

			await transitionEntityStatus({
				tx: ctx.adapter,
				entityType: "batch_item",
				entityId: item.id,
				status: "posted",
				expectedCurrentStatus: "valid",
				metadata: { transaction_id: txnResult.id },
			});
			postedCount++;
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : "Unknown error";
			await transitionEntityStatus({
				tx: ctx.adapter,
				entityType: "batch_item",
				entityId: item.id,
				status: "failed",
				expectedCurrentStatus: "valid",
				metadata: { error_message: errorMsg },
			});
			failedCount++;

			if (mode === "all_or_nothing") {
				// Mark remaining valid items as failed
				const remainingItems = await ctx.adapter.raw<RawItemWithStatusRow>(
					`SELECT bi.*, s.current_status, s.status_metadata
           FROM ${t("batch_item")} bi
           JOIN ${lateralJoin}
           WHERE bi.batch_id = $1 AND s.current_status = 'valid'`,
					[params.batchId],
				);
				for (const remaining of remainingItems) {
					await transitionEntityStatus({
						tx: ctx.adapter,
						entityType: "batch_item",
						entityId: remaining.id,
						status: "failed",
						expectedCurrentStatus: "valid",
						reason: "Aborted: all_or_nothing mode",
						metadata: { error_message: "Aborted: all_or_nothing mode" },
					});
				}
				failedCount += remainingItems.length;
				break;
			}
		}
	}

	// Determine final status
	let finalStatus: BatchStatus;
	if (failedCount === 0 && postedCount > 0) {
		finalStatus = "posted";
	} else if (postedCount === 0 && failedCount > 0) {
		finalStatus = "failed";
	} else if (postedCount > 0 && failedCount > 0) {
		finalStatus = "partial";
	} else {
		finalStatus = "posted";
	}

	const finalMetadata: Record<string, unknown> = {
		posted_items: postedCount,
		failed_items: failedCount,
	};
	if (finalStatus === "posted" || finalStatus === "partial") {
		finalMetadata.posted_at = new Date().toISOString();
	}

	await transitionEntityStatus({
		tx: ctx.adapter,
		entityType: "import_batch",
		entityId: params.batchId,
		status: finalStatus,
		expectedCurrentStatus: "posting",
		metadata: finalMetadata,
	});

	return getBatchStatus(ctx, params.batchId);
}

// =============================================================================
// BATCH ITEM EXECUTION
// =============================================================================

/**
 * Execute a single batch item by dispatching to the appropriate transaction manager function.
 * Each item's parsed data must include `type` (credit/debit/transfer) and standard fields.
 */
async function executeBatchItem(
	ctx: SummaContext,
	data: Record<string, unknown>,
	batchId: string,
	lineNumber: number,
): Promise<LedgerTransaction> {
	const type = String(data.type);
	const amount = Number(data.amount);
	const reference = String(data.reference);
	const description = data.description != null ? String(data.description) : undefined;
	const category = data.category != null ? String(data.category) : undefined;
	const idempotencyKey = `batch-${batchId}-item-${lineNumber}`;

	switch (type) {
		case "credit":
			return creditAccount(ctx, {
				holderId: String(data.holderId),
				amount,
				reference,
				description,
				category,
				sourceSystemAccount:
					data.sourceSystemAccount != null ? String(data.sourceSystemAccount) : undefined,
				idempotencyKey,
			});
		case "debit":
			return debitAccount(ctx, {
				holderId: String(data.holderId),
				amount,
				reference,
				description,
				category,
				destinationSystemAccount:
					data.destinationSystemAccount != null ? String(data.destinationSystemAccount) : undefined,
				allowOverdraft: data.allowOverdraft === true || data.allowOverdraft === "true",
				idempotencyKey,
			});
		case "transfer":
			return transfer(ctx, {
				sourceHolderId: String(data.sourceHolderId),
				destinationHolderId: String(data.destinationHolderId),
				amount,
				reference,
				description,
				category,
				idempotencyKey,
			});
		default:
			throw SummaError.invalidArgument(`Unknown batch item type: ${type}`);
	}
}

// =============================================================================
// PLUGIN FACTORY
// =============================================================================

export function batchImport(options?: BatchImportOptions): SummaPlugin {
	return {
		id: "batch-import",

		schema: {
			import_batch: {
				columns: {
					id: { type: "uuid", primaryKey: true },
					name: { type: "text", notNull: true },
					format: { type: "text", notNull: true },
					total_items: { type: "integer", default: "0" },
					created_by: { type: "text" },
					created_at: { type: "timestamp", default: "NOW()" },
				},
				indexes: [],
			},
			batch_item: {
				columns: {
					id: { type: "uuid", primaryKey: true },
					batch_id: {
						type: "uuid",
						notNull: true,
						references: { table: "import_batch", column: "id" },
					},
					line_number: { type: "integer", notNull: true },
					raw_data: { type: "jsonb", notNull: true },
					created_at: { type: "timestamp", default: "NOW()" },
				},
				indexes: [{ name: "idx_batch_item_batch", columns: ["batch_id"] }],
			},
		},

		workers: [
			{
				id: "batch-processor",
				description: "Process batches with status 'posting'",
				interval: "30s",
				leaseRequired: true,
				handler: async (ctx) => {
					const t = createTableResolver(ctx.options.schema);
					const lateralJoin = statusLateralJoin(t, "import_batch", "b", "s");
					const batches = await ctx.adapter.raw<RawBatchWithStatusRow>(
						`SELECT b.*, s.current_status, s.status_metadata
             FROM ${t("import_batch")} b
             JOIN ${lateralJoin}
             WHERE s.current_status = 'posting'
             LIMIT 5`,
						[],
					);
					for (const batch of batches) {
						try {
							await postBatch(ctx, { batchId: batch.id, mode: "continue_on_error" });
						} catch (err) {
							ctx.logger.error("Batch processing failed", {
								batchId: batch.id,
								error: err instanceof Error ? err.message : "Unknown error",
							});
						}
					}
				},
			},
		],

		endpoints: [
			{
				method: "GET",
				path: "/batches",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const result = await listBatches(ctx, {
						status: req.query?.status as BatchStatus | undefined,
						page: req.query?.page ? Number(req.query.page) : undefined,
						perPage: req.query?.perPage ? Number(req.query.perPage) : undefined,
					});
					return jsonRes(200, result);
				},
			},
			{
				method: "POST",
				path: "/batches",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const body = req.body as {
						name: string;
						format: "csv" | "json";
						data: string | Record<string, unknown>[];
						createdBy?: string;
					};
					if (!body.name || !body.format || !body.data) {
						return jsonRes(400, {
							error: { code: "INVALID_ARGUMENT", message: "name, format, data required" },
						});
					}
					const batch = await createBatch(ctx, body, options);
					return jsonRes(201, batch);
				},
			},
			{
				method: "GET",
				path: "/batches/:id",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const batch = await getBatchStatus(ctx, req.params.id ?? "");
					return jsonRes(200, batch);
				},
			},
			{
				method: "POST",
				path: "/batches/:id/validate",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const batch = await validateBatch(ctx, req.params.id ?? "");
					return jsonRes(200, batch);
				},
			},
			{
				method: "POST",
				path: "/batches/:id/post",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const body = req.body as { mode?: "all_or_nothing" | "continue_on_error" };
					const batch = await postBatch(ctx, {
						batchId: req.params.id ?? "",
						mode: body.mode,
					});
					return jsonRes(200, batch);
				},
			},
		],
	};
}
