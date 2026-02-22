// =============================================================================
// AR/AP & INVOICING PLUGIN
// =============================================================================
// Accounts Receivable / Accounts Payable with invoice lifecycle management.
// Tracks invoices, payment allocations, and aging analysis.
//
// Schema: invoice, payment_allocation, aging_snapshot
// Hooks: afterTransaction (auto-match payments to invoices by reference)
// Workers: invoice-overdue-checker (mark overdue + persist aging snapshots)

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

export interface ArApOptions {
	/** Aging buckets in days. Default: [30, 60, 90, 120] */
	agingBuckets?: number[];
	/** Auto-match payments to invoices by reference. Default: true */
	autoMatch?: boolean;
	/** Aging snapshot worker interval. Default: "1d" */
	agingSnapshotInterval?: string;
	/** Auto-generate invoice numbers. Default: true */
	autoNumber?: boolean;
	/** Invoice number prefix. Default: "INV-" */
	invoicePrefix?: string;
}

export type InvoiceType = "receivable" | "payable";
export type InvoiceStatus = "draft" | "issued" | "partially_paid" | "paid" | "overdue" | "void";

export interface Invoice {
	id: string;
	invoiceNumber: string;
	type: InvoiceType;
	holderId: string;
	counterpartyId: string;
	currency: string;
	totalAmount: number;
	paidAmount: number;
	remainingAmount: number;
	status: InvoiceStatus;
	issueDate: string | null;
	dueDate: string;
	lineItems: InvoiceLineItem[];
	metadata: Record<string, unknown>;
	createdAt: string;
}

export interface InvoiceLineItem {
	description: string;
	quantity: number;
	unitPrice: number;
	amount: number;
	accountCode?: string;
}

export interface PaymentAllocation {
	id: string;
	invoiceId: string;
	transactionId: string;
	amount: number;
	allocatedAt: string;
}

export interface AgingSnapshot {
	id: string;
	type: InvoiceType;
	snapshotDate: string;
	buckets: Record<string, number>;
	totalOutstanding: number;
}

// =============================================================================
// RAW ROW TYPES
// =============================================================================

interface RawInvoiceRow {
	id: string;
	invoice_number: string;
	type: string;
	holder_id: string;
	counterparty_id: string;
	currency: string;
	total_amount: number;
	paid_amount: number;
	status: string;
	issue_date: string | Date | null;
	due_date: string | Date;
	line_items: InvoiceLineItem[];
	metadata: Record<string, unknown>;
	created_at: string | Date;
}

interface RawAllocationRow {
	id: string;
	invoice_id: string;
	transaction_id: string;
	amount: number;
	allocated_at: string | Date;
}

// =============================================================================
// SCHEMA
// =============================================================================

const arApSchema: Record<string, TableDefinition> = {
	invoice: {
		columns: {
			id: { type: "uuid", primaryKey: true, notNull: true },
			invoice_number: { type: "text", notNull: true },
			type: { type: "text", notNull: true },
			ledger_id: { type: "text", notNull: true },
			holder_id: { type: "text", notNull: true },
			counterparty_id: { type: "text", notNull: true },
			currency: { type: "text", notNull: true },
			total_amount: { type: "bigint", notNull: true },
			paid_amount: { type: "bigint", notNull: true, default: "0" },
			status: { type: "text", notNull: true, default: "'draft'" },
			issue_date: { type: "timestamp" },
			due_date: { type: "timestamp", notNull: true },
			line_items: { type: "jsonb", notNull: true, default: "'[]'" },
			metadata: { type: "jsonb", notNull: true, default: "'{}'" },
			created_at: { type: "timestamp", notNull: true, default: "NOW()" },
		},
		indexes: [
			{
				name: "idx_invoice_number",
				columns: ["invoice_number", "ledger_id"],
				unique: true,
			},
			{ name: "idx_invoice_holder", columns: ["holder_id"] },
			{ name: "idx_invoice_counterparty", columns: ["counterparty_id"] },
			{ name: "idx_invoice_status", columns: ["status"] },
			{ name: "idx_invoice_due_date", columns: ["due_date"] },
			{ name: "idx_invoice_ledger", columns: ["ledger_id"] },
		],
	},
	payment_allocation: {
		columns: {
			id: { type: "uuid", primaryKey: true, notNull: true },
			invoice_id: {
				type: "uuid",
				notNull: true,
				references: { table: "invoice", column: "id" },
			},
			transaction_id: { type: "text", notNull: true },
			amount: { type: "bigint", notNull: true },
			allocated_at: { type: "timestamp", notNull: true, default: "NOW()" },
		},
		indexes: [
			{ name: "idx_payment_alloc_invoice", columns: ["invoice_id"] },
			{ name: "idx_payment_alloc_txn", columns: ["transaction_id"] },
		],
	},
	aging_snapshot: {
		columns: {
			id: { type: "uuid", primaryKey: true, notNull: true },
			ledger_id: { type: "text", notNull: true },
			type: { type: "text", notNull: true },
			snapshot_date: { type: "timestamp", notNull: true },
			buckets: { type: "jsonb", notNull: true },
			total_outstanding: { type: "bigint", notNull: true },
			created_at: { type: "timestamp", notNull: true, default: "NOW()" },
		},
		indexes: [
			{ name: "idx_aging_snapshot_date", columns: ["snapshot_date"] },
			{ name: "idx_aging_ledger_type", columns: ["ledger_id", "type"] },
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

function rawToInvoice(row: RawInvoiceRow): Invoice {
	const totalAmount = Number(row.total_amount);
	const paidAmount = Number(row.paid_amount);
	return {
		id: row.id,
		invoiceNumber: row.invoice_number,
		type: row.type as InvoiceType,
		holderId: row.holder_id,
		counterpartyId: row.counterparty_id,
		currency: row.currency,
		totalAmount,
		paidAmount,
		remainingAmount: totalAmount - paidAmount,
		status: row.status as InvoiceStatus,
		issueDate: toIsoOrNull(row.issue_date),
		dueDate: toIso(row.due_date),
		lineItems: Array.isArray(row.line_items) ? row.line_items : [],
		metadata: row.metadata ?? {},
		createdAt: toIso(row.created_at),
	};
}

function rawToAllocation(row: RawAllocationRow): PaymentAllocation {
	return {
		id: row.id,
		invoiceId: row.invoice_id,
		transactionId: row.transaction_id,
		amount: Number(row.amount),
		allocatedAt: toIso(row.allocated_at),
	};
}

function jsonRes(status: number, body: unknown): PluginApiResponse {
	return { status, body };
}

// =============================================================================
// CORE OPERATIONS
// =============================================================================

export async function createInvoice(
	ctx: SummaContext,
	params: {
		type: InvoiceType;
		holderId: string;
		counterpartyId: string;
		currency?: string;
		totalAmount: number;
		dueDate: string;
		lineItems?: InvoiceLineItem[];
		metadata?: Record<string, unknown>;
		invoiceNumber?: string;
	},
	pluginOptions?: ArApOptions,
): Promise<Invoice> {
	const t = createTableResolver(ctx.options.schema);
	const d = ctx.dialect;
	const ledgerId = getLedgerId(ctx);
	const currency = params.currency ?? ctx.options.currency;

	let invoiceNumber = params.invoiceNumber;
	if (!invoiceNumber && pluginOptions?.autoNumber !== false) {
		const prefix = pluginOptions?.invoicePrefix ?? "INV-";
		const [countRow] = await ctx.adapter.raw<{ count: number }>(
			`SELECT COUNT(*) as count FROM ${t("invoice")} WHERE ledger_id = $1`,
			[ledgerId],
		);
		invoiceNumber = `${prefix}${String((countRow?.count ?? 0) + 1).padStart(6, "0")}`;
	}

	if (!invoiceNumber) throw SummaError.invalidArgument("Invoice number is required");

	const rows = await ctx.adapter.raw<RawInvoiceRow>(
		`INSERT INTO ${t("invoice")}
		 (id, invoice_number, type, ledger_id, holder_id, counterparty_id, currency,
		  total_amount, due_date, line_items, metadata, status, created_at)
		 VALUES (${d.generateUuid()}, $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb,
		         'draft', ${d.now()})
		 RETURNING *`,
		[
			invoiceNumber,
			params.type,
			ledgerId,
			params.holderId,
			params.counterpartyId,
			currency,
			params.totalAmount,
			params.dueDate,
			JSON.stringify(params.lineItems ?? []),
			JSON.stringify(params.metadata ?? {}),
		],
	);

	const row = rows[0];
	if (!row) throw SummaError.internal("Failed to create invoice");
	return rawToInvoice(row);
}

export async function issueInvoice(ctx: SummaContext, invoiceId: string): Promise<Invoice> {
	const t = createTableResolver(ctx.options.schema);
	const rows = await ctx.adapter.raw<RawInvoiceRow>(
		`UPDATE ${t("invoice")} SET status = 'issued', issue_date = NOW()
		 WHERE id = $1 AND status = 'draft' RETURNING *`,
		[invoiceId],
	);
	if (!rows[0]) throw SummaError.conflict("Invoice not in draft status or not found");
	return rawToInvoice(rows[0]);
}

export async function allocatePayment(
	ctx: SummaContext,
	params: { invoiceId: string; transactionId: string; amount: number },
): Promise<PaymentAllocation> {
	const t = createTableResolver(ctx.options.schema);
	const d = ctx.dialect;

	const invoices = await ctx.adapter.raw<RawInvoiceRow>(
		`SELECT * FROM ${t("invoice")} WHERE id = $1`,
		[params.invoiceId],
	);
	const inv = invoices[0];
	if (!inv) throw SummaError.notFound("Invoice not found");
	if (inv.status === "paid" || inv.status === "void") {
		throw SummaError.conflict(`Invoice is ${inv.status}`);
	}

	const remaining = Number(inv.total_amount) - Number(inv.paid_amount);
	if (params.amount > remaining) {
		throw SummaError.invalidArgument(
			`Payment amount ${params.amount} exceeds remaining ${remaining}`,
		);
	}

	const allocRows = await ctx.adapter.raw<RawAllocationRow>(
		`INSERT INTO ${t("payment_allocation")} (id, invoice_id, transaction_id, amount)
		 VALUES (${d.generateUuid()}, $1, $2, $3) RETURNING *`,
		[params.invoiceId, params.transactionId, params.amount],
	);

	const newPaid = Number(inv.paid_amount) + params.amount;
	const newStatus = newPaid >= Number(inv.total_amount) ? "paid" : "partially_paid";
	await ctx.adapter.rawMutate(
		`UPDATE ${t("invoice")} SET paid_amount = $1, status = $2 WHERE id = $3`,
		[newPaid, newStatus, params.invoiceId],
	);

	const alloc = allocRows[0];
	if (!alloc) throw SummaError.internal("Failed to allocate payment");
	return rawToAllocation(alloc);
}

export async function voidInvoice(ctx: SummaContext, invoiceId: string): Promise<Invoice> {
	const t = createTableResolver(ctx.options.schema);
	const rows = await ctx.adapter.raw<RawInvoiceRow>(
		`UPDATE ${t("invoice")} SET status = 'void'
		 WHERE id = $1 AND status IN ('draft', 'issued') RETURNING *`,
		[invoiceId],
	);
	if (!rows[0]) throw SummaError.conflict("Invoice cannot be voided (already paid or not found)");
	return rawToInvoice(rows[0]);
}

export async function getInvoice(ctx: SummaContext, invoiceId: string): Promise<Invoice> {
	const t = createTableResolver(ctx.options.schema);
	const rows = await ctx.adapter.raw<RawInvoiceRow>(`SELECT * FROM ${t("invoice")} WHERE id = $1`, [
		invoiceId,
	]);
	if (!rows[0]) throw SummaError.notFound("Invoice not found");
	return rawToInvoice(rows[0]);
}

export async function listInvoices(
	ctx: SummaContext,
	params?: {
		type?: InvoiceType;
		status?: InvoiceStatus;
		holderId?: string;
		limit?: number;
		offset?: number;
	},
): Promise<Invoice[]> {
	const t = createTableResolver(ctx.options.schema);
	const ledgerId = getLedgerId(ctx);
	const conditions: string[] = ["ledger_id = $1"];
	const queryParams: unknown[] = [ledgerId];
	let idx = 2;

	if (params?.type) {
		conditions.push(`type = $${idx++}`);
		queryParams.push(params.type);
	}
	if (params?.status) {
		conditions.push(`status = $${idx++}`);
		queryParams.push(params.status);
	}
	if (params?.holderId) {
		conditions.push(`holder_id = $${idx++}`);
		queryParams.push(params.holderId);
	}

	queryParams.push(params?.limit ?? 50, params?.offset ?? 0);

	const rows = await ctx.adapter.raw<RawInvoiceRow>(
		`SELECT * FROM ${t("invoice")}
		 WHERE ${conditions.join(" AND ")}
		 ORDER BY created_at DESC
		 LIMIT $${idx++} OFFSET $${idx}`,
		queryParams,
	);
	return rows.map(rawToInvoice);
}

export async function getAgingReport(
	ctx: SummaContext,
	params: { type: InvoiceType; buckets?: number[] },
): Promise<AgingSnapshot> {
	const t = createTableResolver(ctx.options.schema);
	const ledgerId = getLedgerId(ctx);
	const buckets = params.buckets ?? [30, 60, 90, 120];

	const rows = await ctx.adapter.raw<{
		due_date: string | Date;
		remaining: number;
	}>(
		`SELECT due_date, (total_amount - paid_amount) as remaining
		 FROM ${t("invoice")}
		 WHERE ledger_id = $1 AND type = $2
		   AND status IN ('issued', 'partially_paid', 'overdue')`,
		[ledgerId, params.type],
	);

	const now = Date.now();
	const bucketMap: Record<string, number> = {};
	let totalOutstanding = 0;

	const lastBucket = buckets[buckets.length - 1] ?? 0;
	for (let i = 0; i < buckets.length; i++) {
		const from = i === 0 ? 0 : (buckets[i - 1] ?? 0) + 1;
		bucketMap[`${from}-${buckets[i]}`] = 0;
	}
	bucketMap[`${lastBucket + 1}+`] = 0;

	for (const row of rows) {
		const dueDate =
			row.due_date instanceof Date ? row.due_date.getTime() : new Date(row.due_date).getTime();
		const daysOverdue = Math.max(0, Math.floor((now - dueDate) / (86_400 * 1000)));
		const remaining = Number(row.remaining);
		totalOutstanding += remaining;

		let placed = false;
		for (let i = 0; i < buckets.length; i++) {
			const from = i === 0 ? 0 : (buckets[i - 1] ?? 0) + 1;
			const to = buckets[i] ?? 0;
			if (daysOverdue >= from && daysOverdue <= to) {
				const key = `${from}-${to}`;
				bucketMap[key] = (bucketMap[key] ?? 0) + remaining;
				placed = true;
				break;
			}
		}
		if (!placed) {
			const overflowKey = `${lastBucket + 1}+`;
			bucketMap[overflowKey] = (bucketMap[overflowKey] ?? 0) + remaining;
		}
	}

	return {
		id: "",
		type: params.type,
		snapshotDate: new Date().toISOString(),
		buckets: bucketMap,
		totalOutstanding,
	};
}

export async function listAllocations(
	ctx: SummaContext,
	invoiceId: string,
): Promise<PaymentAllocation[]> {
	const t = createTableResolver(ctx.options.schema);
	const rows = await ctx.adapter.raw<RawAllocationRow>(
		`SELECT * FROM ${t("payment_allocation")}
		 WHERE invoice_id = $1 ORDER BY allocated_at DESC`,
		[invoiceId],
	);
	return rows.map(rawToAllocation);
}

// =============================================================================
// PLUGIN FACTORY
// =============================================================================

export function arAp(options?: ArApOptions): SummaPlugin {
	const agingBuckets = options?.agingBuckets ?? [30, 60, 90, 120];

	return {
		id: "ar-ap",

		$Infer: {} as {
			Invoice: Invoice;
			PaymentAllocation: PaymentAllocation;
			AgingSnapshot: AgingSnapshot;
		},

		schema: arApSchema,

		operationHooks:
			options?.autoMatch !== false
				? {
						after: [
							{
								matcher: (op) =>
									op.type === "transaction.credit" || op.type === "transaction.transfer",
								handler: async ({ operation, context }) => {
									const params = operation.params as Record<string, unknown>;
									const reference = params.reference as string | undefined;
									if (!reference) return;

									const t = createTableResolver(context.options.schema);
									const invoices = await context.adapter.raw<RawInvoiceRow>(
										`SELECT * FROM ${t("invoice")}
										 WHERE invoice_number = $1
										   AND status IN ('issued', 'partially_paid')
										 LIMIT 1`,
										[reference],
									);

									if (invoices[0]) {
										const amount = Number(params.amount ?? 0);
										const txnId = params.transactionId as string | undefined;
										if (amount > 0 && txnId) {
											try {
												await allocatePayment(context, {
													invoiceId: invoices[0].id,
													transactionId: txnId,
													amount,
												});
											} catch {
												context.logger.warn("Auto-match payment failed", {
													invoiceId: invoices[0].id,
													reference,
												});
											}
										}
									}
								},
							},
						],
					}
				: undefined,

		workers: [
			{
				id: "invoice-overdue-checker",
				description: "Mark overdue invoices and compute aging snapshots",
				interval: options?.agingSnapshotInterval ?? "1d",
				leaseRequired: true,
				handler: async (ctx: SummaContext) => {
					const t = createTableResolver(ctx.options.schema);
					const d = ctx.dialect;

					const updated = await ctx.adapter.rawMutate(
						`UPDATE ${t("invoice")}
						 SET status = 'overdue'
						 WHERE status IN ('issued', 'partially_paid')
						   AND due_date < ${d.now()}`,
						[],
					);
					if (updated > 0) {
						ctx.logger.info("Marked invoices as overdue", {
							count: updated,
						});
					}

					const ledgerId = getLedgerId(ctx);
					for (const type of ["receivable", "payable"] as InvoiceType[]) {
						const snapshot = await getAgingReport(ctx, {
							type,
							buckets: agingBuckets,
						});
						if (snapshot.totalOutstanding > 0) {
							await ctx.adapter.rawMutate(
								`INSERT INTO ${t("aging_snapshot")}
								 (id, ledger_id, type, snapshot_date, buckets, total_outstanding)
								 VALUES (${d.generateUuid()}, $1, $2, ${d.now()}, $3::jsonb, $4)`,
								[ledgerId, type, JSON.stringify(snapshot.buckets), snapshot.totalOutstanding],
							);
						}
					}
				},
			},
		],

		endpoints: [
			{
				method: "POST",
				path: "/invoices",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const body = req.body as Parameters<typeof createInvoice>[1];
					if (
						!body.type ||
						!body.holderId ||
						!body.counterpartyId ||
						!body.totalAmount ||
						!body.dueDate
					) {
						return jsonRes(400, {
							error: {
								code: "INVALID_ARGUMENT",
								message: "type, holderId, counterpartyId, totalAmount, dueDate required",
							},
						});
					}
					const invoice = await createInvoice(ctx, body, options);
					return jsonRes(201, invoice);
				},
			},
			{
				method: "GET",
				path: "/invoices",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const invoices = await listInvoices(ctx, {
						type: req.query.type as InvoiceType | undefined,
						status: req.query.status as InvoiceStatus | undefined,
						holderId: req.query.holderId,
						limit: req.query.limit ? Number(req.query.limit) : undefined,
						offset: req.query.offset ? Number(req.query.offset) : undefined,
					});
					return jsonRes(200, invoices);
				},
			},
			{
				method: "GET",
				path: "/invoices/:id",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const invoice = await getInvoice(ctx, req.params.id ?? "");
					return jsonRes(200, invoice);
				},
			},
			{
				method: "POST",
				path: "/invoices/:id/issue",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const invoice = await issueInvoice(ctx, req.params.id ?? "");
					return jsonRes(200, invoice);
				},
			},
			{
				method: "POST",
				path: "/invoices/:id/void",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const invoice = await voidInvoice(ctx, req.params.id ?? "");
					return jsonRes(200, invoice);
				},
			},
			{
				method: "POST",
				path: "/invoices/:id/allocate",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const body = req.body as {
						transactionId: string;
						amount: number;
					};
					if (!body.transactionId || !body.amount) {
						return jsonRes(400, {
							error: {
								code: "INVALID_ARGUMENT",
								message: "transactionId and amount required",
							},
						});
					}
					const alloc = await allocatePayment(ctx, {
						invoiceId: req.params.id ?? "",
						...body,
					});
					return jsonRes(200, alloc);
				},
			},
			{
				method: "GET",
				path: "/invoices/:id/allocations",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const allocs = await listAllocations(ctx, req.params.id ?? "");
					return jsonRes(200, allocs);
				},
			},
			{
				method: "GET",
				path: "/aging/:type",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const type = req.params.type as InvoiceType;
					if (type !== "receivable" && type !== "payable") {
						return jsonRes(400, {
							error: {
								code: "INVALID_ARGUMENT",
								message: "type must be receivable or payable",
							},
						});
					}
					const report = await getAgingReport(ctx, {
						type,
						buckets: agingBuckets,
					});
					return jsonRes(200, report);
				},
			},
		],
	};
}
