// =============================================================================
// TAX TRACKING PLUGIN
// =============================================================================
// afterTransaction hook creates tax entries based on category matching.
// Supports multi-jurisdiction tax with time-varying rates.
//
// Schema: tax_code, tax_rate, tax_entry
// Hooks: afterTransaction (auto-create tax entries by category match)
// Workers: none (entries created synchronously in hooks)

import type {
	PluginApiRequest,
	PluginApiResponse,
	SummaContext,
	SummaPlugin,
	TableDefinition,
} from "@summa/core";
import { SummaError } from "@summa/core";
import { createTableResolver } from "@summa/core/db";
import { getLedgerId } from "../managers/ledger-helpers.js";

// =============================================================================
// TYPES
// =============================================================================

export interface TaxTrackingOptions {
	/** Tax codes to seed on init */
	taxCodes?: Array<{
		code: string;
		name: string;
		rate: number;
		jurisdiction: string;
		category?: string;
	}>;
	/** Auto-calculate tax on transactions with matching category. Default: true */
	autoCalculate?: boolean;
}

export interface TaxCode {
	id: string;
	code: string;
	name: string;
	jurisdiction: string;
	category: string | null;
	enabled: boolean;
	createdAt: string;
}

export interface TaxRate {
	id: string;
	taxCodeId: string;
	rate: number;
	effectiveFrom: string;
	effectiveTo: string | null;
}

export interface TaxEntry {
	id: string;
	transactionId: string;
	taxCodeId: string;
	taxableAmount: number;
	taxAmount: number;
	rate: number;
	jurisdiction: string;
	createdAt: string;
}

export interface TaxSummary {
	jurisdiction: string;
	totalTaxable: number;
	totalTax: number;
	entries: number;
}

// =============================================================================
// RAW ROW TYPES
// =============================================================================

interface RawTaxCodeRow {
	id: string;
	code: string;
	name: string;
	jurisdiction: string;
	category: string | null;
	enabled: boolean;
	created_at: string | Date;
}

interface RawTaxRateRow {
	id: string;
	tax_code_id: string;
	rate: number;
	effective_from: string | Date;
	effective_to: string | Date | null;
}

interface RawTaxEntryRow {
	id: string;
	transaction_id: string;
	tax_code_id: string;
	taxable_amount: number;
	tax_amount: number;
	rate: number;
	jurisdiction: string;
	created_at: string | Date;
}

// =============================================================================
// SCHEMA
// =============================================================================

const taxSchema: Record<string, TableDefinition> = {
	tax_code: {
		columns: {
			id: { type: "uuid", primaryKey: true, notNull: true },
			code: { type: "text", notNull: true },
			name: { type: "text", notNull: true },
			ledger_id: { type: "text", notNull: true },
			jurisdiction: { type: "text", notNull: true },
			category: { type: "text" },
			enabled: { type: "boolean", notNull: true, default: "true" },
			created_at: { type: "timestamp", notNull: true, default: "NOW()" },
		},
		indexes: [
			{
				name: "idx_tax_code_code",
				columns: ["code", "ledger_id"],
				unique: true,
			},
			{ name: "idx_tax_code_jurisdiction", columns: ["jurisdiction"] },
			{ name: "idx_tax_code_category", columns: ["category"] },
		],
	},
	tax_rate: {
		columns: {
			id: { type: "uuid", primaryKey: true, notNull: true },
			tax_code_id: {
				type: "uuid",
				notNull: true,
				references: { table: "tax_code", column: "id" },
			},
			rate: { type: "integer", notNull: true },
			effective_from: { type: "timestamp", notNull: true },
			effective_to: { type: "timestamp" },
			created_at: { type: "timestamp", notNull: true, default: "NOW()" },
		},
		indexes: [
			{ name: "idx_tax_rate_code", columns: ["tax_code_id"] },
			{
				name: "idx_tax_rate_effective",
				columns: ["effective_from", "effective_to"],
			},
		],
	},
	tax_entry: {
		columns: {
			id: { type: "uuid", primaryKey: true, notNull: true },
			ledger_id: { type: "text", notNull: true },
			transaction_id: { type: "text", notNull: true },
			tax_code_id: {
				type: "uuid",
				notNull: true,
				references: { table: "tax_code", column: "id" },
			},
			taxable_amount: { type: "bigint", notNull: true },
			tax_amount: { type: "bigint", notNull: true },
			rate: { type: "integer", notNull: true },
			jurisdiction: { type: "text", notNull: true },
			created_at: { type: "timestamp", notNull: true, default: "NOW()" },
		},
		indexes: [
			{ name: "idx_tax_entry_txn", columns: ["transaction_id"] },
			{ name: "idx_tax_entry_code", columns: ["tax_code_id"] },
			{ name: "idx_tax_entry_jurisdiction", columns: ["jurisdiction"] },
			{ name: "idx_tax_entry_ledger", columns: ["ledger_id"] },
			{ name: "idx_tax_entry_created", columns: ["created_at"] },
		],
	},
};

// =============================================================================
// HELPERS
// =============================================================================

function toIso(v: string | Date): string {
	return v instanceof Date ? v.toISOString() : String(v);
}

function toIsoOrNull(v: string | Date | null | undefined): string | null {
	if (v == null) return null;
	return v instanceof Date ? v.toISOString() : String(v);
}

function jsonRes(status: number, body: unknown): PluginApiResponse {
	return { status, body };
}

function rawToTaxCode(row: RawTaxCodeRow): TaxCode {
	return {
		id: row.id,
		code: row.code,
		name: row.name,
		jurisdiction: row.jurisdiction,
		category: row.category,
		enabled: row.enabled,
		createdAt: toIso(row.created_at),
	};
}

function rawToTaxRate(row: RawTaxRateRow): TaxRate {
	return {
		id: row.id,
		taxCodeId: row.tax_code_id,
		rate: Number(row.rate),
		effectiveFrom: toIso(row.effective_from),
		effectiveTo: toIsoOrNull(row.effective_to),
	};
}

function rawToTaxEntry(row: RawTaxEntryRow): TaxEntry {
	return {
		id: row.id,
		transactionId: row.transaction_id,
		taxCodeId: row.tax_code_id,
		taxableAmount: Number(row.taxable_amount),
		taxAmount: Number(row.tax_amount),
		rate: Number(row.rate),
		jurisdiction: row.jurisdiction,
		createdAt: toIso(row.created_at),
	};
}

// =============================================================================
// CORE OPERATIONS
// =============================================================================

export async function createTaxCode(
	ctx: SummaContext,
	params: {
		code: string;
		name: string;
		rate: number;
		jurisdiction: string;
		category?: string;
		effectiveFrom?: string;
	},
): Promise<TaxCode> {
	const t = createTableResolver(ctx.options.schema);
	const d = ctx.dialect;
	const ledgerId = getLedgerId(ctx);

	const rows = await ctx.adapter.raw<RawTaxCodeRow>(
		`INSERT INTO ${t("tax_code")} (id, code, name, ledger_id, jurisdiction, category)
		 VALUES (${d.generateUuid()}, $1, $2, $3, $4, $5)
		 RETURNING *`,
		[params.code, params.name, ledgerId, params.jurisdiction, params.category ?? null],
	);

	const taxCode = rows[0];
	if (!taxCode) throw SummaError.internal("Failed to create tax code");

	// Create initial rate
	await ctx.adapter.rawMutate(
		`INSERT INTO ${t("tax_rate")} (id, tax_code_id, rate, effective_from)
		 VALUES (${d.generateUuid()}, $1, $2, $3)`,
		[taxCode.id, params.rate, params.effectiveFrom ?? new Date().toISOString()],
	);

	return rawToTaxCode(taxCode);
}

export async function updateTaxRate(
	ctx: SummaContext,
	params: {
		taxCodeId: string;
		rate: number;
		effectiveFrom: string;
	},
): Promise<TaxRate> {
	const t = createTableResolver(ctx.options.schema);
	const d = ctx.dialect;

	// Close the current rate period
	await ctx.adapter.rawMutate(
		`UPDATE ${t("tax_rate")}
		 SET effective_to = $1
		 WHERE tax_code_id = $2
		   AND effective_to IS NULL`,
		[params.effectiveFrom, params.taxCodeId],
	);

	// Insert new rate
	const rows = await ctx.adapter.raw<RawTaxRateRow>(
		`INSERT INTO ${t("tax_rate")} (id, tax_code_id, rate, effective_from)
		 VALUES (${d.generateUuid()}, $1, $2, $3)
		 RETURNING *`,
		[params.taxCodeId, params.rate, params.effectiveFrom],
	);

	if (!rows[0]) throw SummaError.internal("Failed to create tax rate");
	return rawToTaxRate(rows[0]);
}

export async function getCurrentRate(ctx: SummaContext, taxCodeId: string): Promise<number> {
	const t = createTableResolver(ctx.options.schema);
	const rows = await ctx.adapter.raw<{ rate: number }>(
		`SELECT rate FROM ${t("tax_rate")}
		 WHERE tax_code_id = $1
		   AND effective_from <= NOW()
		   AND (effective_to IS NULL OR effective_to > NOW())
		 ORDER BY effective_from DESC LIMIT 1`,
		[taxCodeId],
	);
	if (!rows[0]) throw SummaError.notFound("No active rate for tax code");
	return Number(rows[0].rate);
}

export async function listTaxCodes(ctx: SummaContext): Promise<TaxCode[]> {
	const t = createTableResolver(ctx.options.schema);
	const ledgerId = getLedgerId(ctx);
	const rows = await ctx.adapter.raw<RawTaxCodeRow>(
		`SELECT * FROM ${t("tax_code")} WHERE ledger_id = $1 ORDER BY code`,
		[ledgerId],
	);
	return rows.map(rawToTaxCode);
}

export async function listTaxRates(ctx: SummaContext, taxCodeId: string): Promise<TaxRate[]> {
	const t = createTableResolver(ctx.options.schema);
	const rows = await ctx.adapter.raw<RawTaxRateRow>(
		`SELECT * FROM ${t("tax_rate")}
		 WHERE tax_code_id = $1
		 ORDER BY effective_from DESC`,
		[taxCodeId],
	);
	return rows.map(rawToTaxRate);
}

export async function getEntriesForTransaction(
	ctx: SummaContext,
	transactionId: string,
): Promise<TaxEntry[]> {
	const t = createTableResolver(ctx.options.schema);
	const rows = await ctx.adapter.raw<RawTaxEntryRow>(
		`SELECT * FROM ${t("tax_entry")} WHERE transaction_id = $1`,
		[transactionId],
	);
	return rows.map(rawToTaxEntry);
}

export async function getTaxSummary(
	ctx: SummaContext,
	params: {
		dateFrom: string;
		dateTo: string;
		jurisdiction?: string;
	},
): Promise<TaxSummary[]> {
	const t = createTableResolver(ctx.options.schema);
	const ledgerId = getLedgerId(ctx);
	const jurisdictionFilter = params.jurisdiction ? " AND jurisdiction = $4" : "";
	const queryParams: unknown[] = [ledgerId, params.dateFrom, params.dateTo];
	if (params.jurisdiction) queryParams.push(params.jurisdiction);

	const rows = await ctx.adapter.raw<{
		jurisdiction: string;
		total_taxable: number;
		total_tax: number;
		entries: number;
	}>(
		`SELECT jurisdiction,
		        SUM(taxable_amount) as total_taxable,
		        SUM(tax_amount) as total_tax,
		        COUNT(*)::int as entries
		 FROM ${t("tax_entry")}
		 WHERE ledger_id = $1
		   AND created_at >= $2::timestamptz
		   AND created_at <= $3::timestamptz
		   ${jurisdictionFilter}
		 GROUP BY jurisdiction`,
		queryParams,
	);

	return rows.map((r) => ({
		jurisdiction: r.jurisdiction,
		totalTaxable: Number(r.total_taxable),
		totalTax: Number(r.total_tax),
		entries: r.entries,
	}));
}

// =============================================================================
// PLUGIN FACTORY
// =============================================================================

export function taxTracking(options?: TaxTrackingOptions): SummaPlugin {
	return {
		id: "tax-tracking",

		$Infer: {} as {
			TaxCode: TaxCode;
			TaxRate: TaxRate;
			TaxEntry: TaxEntry;
			TaxSummary: TaxSummary;
		},

		schema: taxSchema,

		init: async (ctx) => {
			if (!options?.taxCodes?.length) return;
			for (const tc of options.taxCodes) {
				try {
					await createTaxCode(ctx, tc);
				} catch {
					// Ignore duplicates on re-init
				}
			}
		},

		operationHooks:
			options?.autoCalculate !== false
				? {
						after: [
							{
								matcher: (op) =>
									op.type === "transaction.credit" ||
									op.type === "transaction.debit" ||
									op.type === "transaction.transfer",
								handler: async ({ operation, context }) => {
									const params = operation.params as Record<string, unknown>;
									// Category comes from metadata passed through transaction params
									const category = params.category as string | undefined;
									if (!category) return;

									const t = createTableResolver(context.options.schema);
									const d = context.dialect;
									const ledgerId = getLedgerId(context);

									// Find matching tax codes by category
									const taxCodes = await context.adapter.raw<{
										id: string;
										jurisdiction: string;
									}>(
										`SELECT id, jurisdiction FROM ${t("tax_code")}
										 WHERE ledger_id = $1 AND category = $2 AND enabled = true`,
										[ledgerId, category],
									);

									for (const tc of taxCodes) {
										try {
											const rate = await getCurrentRate(context, tc.id);
											const amount = Number(params.amount ?? 0);
											// Rate is in basis points (e.g., 1800 = 18%)
											const taxAmount = Math.round((amount * rate) / 10_000);

											await context.adapter.rawMutate(
												`INSERT INTO ${t("tax_entry")}
												 (id, ledger_id, transaction_id, tax_code_id,
												  taxable_amount, tax_amount, rate, jurisdiction)
												 VALUES (${d.generateUuid()}, $1, $2, $3, $4, $5, $6, $7)`,
												[
													ledgerId,
													(params.transactionId ?? params.reference) as string,
													tc.id,
													amount,
													taxAmount,
													rate,
													tc.jurisdiction,
												],
											);
										} catch (err) {
											context.logger.warn("Tax entry creation failed", {
												taxCodeId: tc.id,
												error: String(err),
											});
										}
									}
								},
							},
						],
					}
				: undefined,

		endpoints: [
			{
				method: "GET",
				path: "/tax/codes",
				handler: async (_req: PluginApiRequest, ctx: SummaContext) => {
					const codes = await listTaxCodes(ctx);
					return jsonRes(200, codes);
				},
			},
			{
				method: "POST",
				path: "/tax/codes",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const body = req.body as Parameters<typeof createTaxCode>[1];
					if (!body.code || !body.name || body.rate == null || !body.jurisdiction) {
						return jsonRes(400, {
							error: {
								code: "INVALID_ARGUMENT",
								message: "code, name, rate, jurisdiction required",
							},
						});
					}
					const code = await createTaxCode(ctx, body);
					return jsonRes(201, code);
				},
			},
			{
				method: "GET",
				path: "/tax/codes/:id/rates",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const rates = await listTaxRates(ctx, req.params.id ?? "");
					return jsonRes(200, rates);
				},
			},
			{
				method: "POST",
				path: "/tax/codes/:id/rates",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const body = req.body as {
						rate: number;
						effectiveFrom: string;
					};
					if (body.rate == null || !body.effectiveFrom) {
						return jsonRes(400, {
							error: {
								code: "INVALID_ARGUMENT",
								message: "rate and effectiveFrom required",
							},
						});
					}
					const rate = await updateTaxRate(ctx, {
						taxCodeId: req.params.id ?? "",
						...body,
					});
					return jsonRes(201, rate);
				},
			},
			{
				method: "GET",
				path: "/tax/entries/:transactionId",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const entries = await getEntriesForTransaction(ctx, req.params.transactionId ?? "");
					return jsonRes(200, entries);
				},
			},
			{
				method: "GET",
				path: "/tax/summary",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const { dateFrom, dateTo } = req.query;
					if (!dateFrom || !dateTo) {
						return jsonRes(400, {
							error: {
								code: "INVALID_ARGUMENT",
								message: "dateFrom and dateTo required",
							},
						});
					}
					const summary = await getTaxSummary(ctx, {
						dateFrom,
						dateTo,
						jurisdiction: req.query.jurisdiction,
					});
					return jsonRes(200, summary);
				},
			},
		],
	};
}
