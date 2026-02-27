// =============================================================================
// STATEMENTS PLUGIN — Account statement generation with CSV/JSON download
// =============================================================================
// Generates account statements for any date range. Combines entry and
// transfer data to produce line-item statements with computed
// summaries (opening/closing balance, totals).
//
// Supports async background generation for CSV/PDF via the statement_job table
// and a background worker, preventing request timeouts on large statements.
//
// Status tracking uses entity_status_log (append-only) instead of a mutable
// status column on statement_job.

import { randomUUID } from "node:crypto";
import type {
	PluginApiResponse,
	PluginEndpoint,
	SummaContext,
	SummaPlugin,
} from "@summa-ledger/core";
import { minorToDecimal } from "@summa-ledger/core";
import { createTableResolver } from "@summa-ledger/core/db";
import PDFDocument from "pdfkit";
import { initializeEntityStatus, transitionEntityStatus } from "../infrastructure/entity-status.js";
import { getLedgerId } from "../managers/ledger-helpers.js";

// =============================================================================
// TYPES
// =============================================================================

export interface StatementOptions {
	/** Base path prefix for statement routes (default: "/statements") */
	basePath?: string;
}

export interface StatementEntry {
	entryId: string;
	transactionId: string;
	transactionRef: string;
	description: string | null;
	entryType: "DEBIT" | "CREDIT";
	amount: number;
	amountDecimal: string;
	currency: string;
	balanceBefore: number | null;
	balanceAfter: number | null;
	date: string;
}

export interface StatementSummary {
	holderId: string;
	accountId: string;
	currency: string;
	dateFrom: string;
	dateTo: string;
	openingBalance: number;
	closingBalance: number;
	totalCredits: number;
	totalDebits: number;
	netChange: number;
	transactionCount: number;
	entryCount: number;
}

export interface StatementResult {
	summary: StatementSummary;
	entries: StatementEntry[];
	hasMore: boolean;
	total: number;
}

// =============================================================================
// INTERNAL RAW ROW TYPES
// =============================================================================

interface RawEntryRow {
	entry_id: string;
	transaction_id: string;
	transaction_ref: string;
	description: string | null;
	entry_type: string;
	amount: number;
	currency: string;
	balance_before: number | null;
	balance_after: number | null;
	created_at: string | Date;
}

interface RawSummaryRow {
	total_credits: number;
	total_debits: number;
	transaction_count: number;
	entry_count: number;
}

interface RawBalanceRow {
	balance_after: number;
}

interface RawCountRow {
	cnt: number;
}

// =============================================================================
// HELPERS
// =============================================================================

function json(status: number, body: unknown): PluginApiResponse {
	return { status, body };
}

function mapEntryRow(row: RawEntryRow, currency: string): StatementEntry {
	return {
		entryId: row.entry_id,
		transactionId: row.transaction_id,
		transactionRef: row.transaction_ref,
		description: row.description,
		entryType: row.entry_type as "DEBIT" | "CREDIT",
		amount: Number(row.amount),
		amountDecimal: minorToDecimal(Number(row.amount), currency),
		currency,
		balanceBefore: row.balance_before != null ? Number(row.balance_before) : null,
		balanceAfter: row.balance_after != null ? Number(row.balance_after) : null,
		date: typeof row.created_at === "string" ? row.created_at : row.created_at.toISOString(),
	};
}

function escapeCsvField(value: string): string {
	// Prevent CSV formula injection — prefix formula-trigger characters with a single quote
	// so spreadsheet apps treat the value as text, not a formula
	let safe = value;
	if (/^[=+\-@\t\r]/.test(safe)) {
		safe = `'${safe}`;
	}
	if (safe.includes(",") || safe.includes('"') || safe.includes("\n") || safe !== value) {
		return `"${safe.replace(/"/g, '""')}"`;
	}
	return safe;
}

function resolveDate(date: string | undefined, fallback: string): string {
	return date ?? fallback;
}

async function resolveAccount(
	ctx: SummaContext,
	holderId: string,
): Promise<{ id: string; currency: string } | null> {
	const t = createTableResolver(ctx.options.schema);
	const ledgerId = getLedgerId(ctx);
	const rows = await ctx.readAdapter.raw<{ id: string; currency: string }>(
		`SELECT id, currency FROM ${t("account")} WHERE ledger_id = $1 AND holder_id = $2 LIMIT 1`,
		[ledgerId, holderId],
	);
	return rows[0] ?? null;
}

// =============================================================================
// CORE QUERY FUNCTIONS
// =============================================================================

async function queryEntries(
	ctx: SummaContext,
	accountId: string,
	dateFrom: string,
	dateTo: string,
	limit: number,
	offset: number,
): Promise<RawEntryRow[]> {
	const t = createTableResolver(ctx.options.schema);
	const ledgerId = getLedgerId(ctx);
	return ctx.readAdapter.raw<RawEntryRow>(
		`SELECT
			e.id            AS entry_id,
			e.transfer_id   AS transaction_id,
			t.reference     AS transaction_ref,
			t.description,
			e.entry_type,
			e.amount,
			e.currency,
			e.balance_before,
			e.balance_after,
			e.created_at
		FROM ${t("entry")} e
		JOIN ${t("transfer")} t ON t.id = e.transfer_id
		WHERE t.ledger_id = $6
			AND e.account_id = $1
			AND e.created_at >= $2::timestamptz
			AND e.created_at < $3::timestamptz
		ORDER BY e.created_at ASC, e.id ASC
		LIMIT $4 OFFSET $5`,
		[accountId, dateFrom, dateTo, limit, offset, ledgerId],
	);
}

async function queryEntryCount(
	ctx: SummaContext,
	accountId: string,
	dateFrom: string,
	dateTo: string,
): Promise<number> {
	const t = createTableResolver(ctx.options.schema);
	const rows = await ctx.readAdapter.raw<RawCountRow>(
		`SELECT COUNT(*)::int AS cnt
		FROM ${t("entry")} e
		WHERE e.account_id = $1
			AND e.created_at >= $2::timestamptz
			AND e.created_at < $3::timestamptz`,
		[accountId, dateFrom, dateTo],
	);
	return Number(rows[0]?.cnt ?? 0);
}

async function queryAggregates(
	ctx: SummaContext,
	accountId: string,
	dateFrom: string,
	dateTo: string,
): Promise<RawSummaryRow> {
	const t = createTableResolver(ctx.options.schema);
	const rows = await ctx.readAdapter.raw<RawSummaryRow>(
		`SELECT
			COALESCE(SUM(CASE WHEN e.entry_type = 'CREDIT' THEN e.amount ELSE 0 END), 0)::bigint AS total_credits,
			COALESCE(SUM(CASE WHEN e.entry_type = 'DEBIT'  THEN e.amount ELSE 0 END), 0)::bigint AS total_debits,
			COUNT(DISTINCT e.transfer_id)::int AS transaction_count,
			COUNT(*)::int AS entry_count
		FROM ${t("entry")} e
		WHERE e.account_id = $1
			AND e.created_at >= $2::timestamptz
			AND e.created_at < $3::timestamptz`,
		[accountId, dateFrom, dateTo],
	);
	return {
		total_credits: Number(rows[0]?.total_credits ?? 0),
		total_debits: Number(rows[0]?.total_debits ?? 0),
		transaction_count: Number(rows[0]?.transaction_count ?? 0),
		entry_count: Number(rows[0]?.entry_count ?? 0),
	};
}

async function queryOpeningBalance(
	ctx: SummaContext,
	accountId: string,
	dateFrom: string,
): Promise<number> {
	const t = createTableResolver(ctx.options.schema);
	const rows = await ctx.readAdapter.raw<RawBalanceRow>(
		`SELECT e.balance_after
		FROM ${t("entry")} e
		WHERE e.account_id = $1
			AND e.created_at < $2::timestamptz
		ORDER BY e.created_at DESC, e.id DESC
		LIMIT 1`,
		[accountId, dateFrom],
	);
	return rows[0] ? Number(rows[0].balance_after) : 0;
}

async function queryClosingBalance(
	ctx: SummaContext,
	accountId: string,
	dateFrom: string,
	dateTo: string,
	openingBalance: number,
): Promise<number> {
	const t = createTableResolver(ctx.options.schema);
	const rows = await ctx.readAdapter.raw<RawBalanceRow>(
		`SELECT e.balance_after
		FROM ${t("entry")} e
		WHERE e.account_id = $1
			AND e.created_at >= $2::timestamptz
			AND e.created_at < $3::timestamptz
		ORDER BY e.created_at DESC, e.id DESC
		LIMIT 1`,
		[accountId, dateFrom, dateTo],
	);
	return rows[0] ? Number(rows[0].balance_after) : openingBalance;
}

// =============================================================================
// STANDALONE QUERY FUNCTIONS
// =============================================================================

/**
 * Generate a full account statement for a date range.
 */
export async function getAccountStatement(
	ctx: SummaContext,
	holderId: string,
	options?: {
		dateFrom?: string;
		dateTo?: string;
		page?: number;
		perPage?: number;
	},
): Promise<StatementResult | null> {
	const account = await resolveAccount(ctx, holderId);
	if (!account) return null;

	const now = new Date().toISOString();
	const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
	const dateFrom = resolveDate(options?.dateFrom, thirtyDaysAgo);
	const dateTo = resolveDate(options?.dateTo, now);
	const page = Math.max(1, options?.page ?? 1);
	const perPage = Math.min(options?.perPage ?? 50, 500);
	const offset = (page - 1) * perPage;

	const [rawEntries, total, aggregates, openingBalance] = await Promise.all([
		queryEntries(ctx, account.id, dateFrom, dateTo, perPage, offset),
		queryEntryCount(ctx, account.id, dateFrom, dateTo),
		queryAggregates(ctx, account.id, dateFrom, dateTo),
		queryOpeningBalance(ctx, account.id, dateFrom),
	]);

	const closingBalance = await queryClosingBalance(
		ctx,
		account.id,
		dateFrom,
		dateTo,
		openingBalance,
	);
	const entries = rawEntries.map((row) => mapEntryRow(row, account.currency));

	return {
		summary: {
			holderId,
			accountId: account.id,
			currency: account.currency,
			dateFrom,
			dateTo,
			openingBalance,
			closingBalance,
			totalCredits: aggregates.total_credits,
			totalDebits: aggregates.total_debits,
			netChange: aggregates.total_credits - aggregates.total_debits,
			transactionCount: aggregates.transaction_count,
			entryCount: aggregates.entry_count,
		},
		entries,
		hasMore: offset + perPage < total,
		total,
	};
}

/**
 * Get only the statement summary (no line items).
 */
export async function getStatementSummary(
	ctx: SummaContext,
	holderId: string,
	options?: { dateFrom?: string; dateTo?: string },
): Promise<StatementSummary | null> {
	const account = await resolveAccount(ctx, holderId);
	if (!account) return null;

	const now = new Date().toISOString();
	const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
	const dateFrom = resolveDate(options?.dateFrom, thirtyDaysAgo);
	const dateTo = resolveDate(options?.dateTo, now);

	const [aggregates, openingBalance] = await Promise.all([
		queryAggregates(ctx, account.id, dateFrom, dateTo),
		queryOpeningBalance(ctx, account.id, dateFrom),
	]);

	const closingBalance = await queryClosingBalance(
		ctx,
		account.id,
		dateFrom,
		dateTo,
		openingBalance,
	);

	return {
		holderId,
		accountId: account.id,
		currency: account.currency,
		dateFrom,
		dateTo,
		openingBalance,
		closingBalance,
		totalCredits: aggregates.total_credits,
		totalDebits: aggregates.total_debits,
		netChange: aggregates.total_credits - aggregates.total_debits,
		transactionCount: aggregates.transaction_count,
		entryCount: aggregates.entry_count,
	};
}

/**
 * Generate a CSV string for an account statement.
 * Fetches all entries in batches (no pagination limit).
 */
export async function generateStatementCsv(
	ctx: SummaContext,
	holderId: string,
	options?: { dateFrom?: string; dateTo?: string },
): Promise<string | null> {
	const account = await resolveAccount(ctx, holderId);
	if (!account) return null;

	const now = new Date().toISOString();
	const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
	const dateFrom = resolveDate(options?.dateFrom, thirtyDaysAgo);
	const dateTo = resolveDate(options?.dateTo, now);
	const currency = account.currency;

	const [aggregates, openingBalance] = await Promise.all([
		queryAggregates(ctx, account.id, dateFrom, dateTo),
		queryOpeningBalance(ctx, account.id, dateFrom),
	]);

	const closingBalance = await queryClosingBalance(
		ctx,
		account.id,
		dateFrom,
		dateTo,
		openingBalance,
	);

	// CSV header comments
	const lines: string[] = [
		"# Account Statement",
		`# Holder ID: ${holderId}`,
		`# Period: ${dateFrom} to ${dateTo}`,
		`# Currency: ${currency}`,
		`# Opening Balance: ${minorToDecimal(openingBalance, currency)}`,
		`# Closing Balance: ${minorToDecimal(closingBalance, currency)}`,
		`# Total Credits: ${minorToDecimal(aggregates.total_credits, currency)}`,
		`# Total Debits: ${minorToDecimal(aggregates.total_debits, currency)}`,
		`# Net Change: ${minorToDecimal(aggregates.total_credits - aggregates.total_debits, currency)}`,
		`# Transactions: ${aggregates.transaction_count}`,
		"#",
		"Date,Transaction Ref,Description,Entry Type,Amount,Amount (Decimal),Currency,Balance Before,Balance After",
	];

	// Fetch all entries in batches
	const BATCH_SIZE = 500;
	let batchOffset = 0;

	while (true) {
		const batch = await queryEntries(ctx, account.id, dateFrom, dateTo, BATCH_SIZE, batchOffset);
		if (batch.length === 0) break;

		for (const row of batch) {
			const entry = mapEntryRow(row, currency);
			lines.push(
				[
					entry.date,
					escapeCsvField(entry.transactionRef),
					escapeCsvField(entry.description ?? ""),
					entry.entryType,
					String(entry.amount),
					entry.amountDecimal,
					entry.currency,
					entry.balanceBefore != null ? String(entry.balanceBefore) : "",
					entry.balanceAfter != null ? String(entry.balanceAfter) : "",
				].join(","),
			);
		}

		if (batch.length < BATCH_SIZE) break;
		batchOffset += BATCH_SIZE;
	}

	return lines.join("\n");
}

/**
 * Generate a PDF buffer for an account statement.
 * Fetches all entries in batches and renders a formatted PDF document.
 */
export async function generateStatementPdf(
	ctx: SummaContext,
	holderId: string,
	options?: { dateFrom?: string; dateTo?: string },
): Promise<Buffer | null> {
	const account = await resolveAccount(ctx, holderId);
	if (!account) return null;

	const now = new Date().toISOString();
	const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
	const dateFrom = resolveDate(options?.dateFrom, thirtyDaysAgo);
	const dateTo = resolveDate(options?.dateTo, now);
	const currency = account.currency;

	const [aggregates, openingBalance] = await Promise.all([
		queryAggregates(ctx, account.id, dateFrom, dateTo),
		queryOpeningBalance(ctx, account.id, dateFrom),
	]);

	const closingBalance = await queryClosingBalance(
		ctx,
		account.id,
		dateFrom,
		dateTo,
		openingBalance,
	);

	// Fetch all entries
	const allEntries: StatementEntry[] = [];
	const BATCH_SIZE = 500;
	let batchOffset = 0;

	while (true) {
		const batch = await queryEntries(ctx, account.id, dateFrom, dateTo, BATCH_SIZE, batchOffset);
		if (batch.length === 0) break;
		for (const row of batch) {
			allEntries.push(mapEntryRow(row, currency));
		}
		if (batch.length < BATCH_SIZE) break;
		batchOffset += BATCH_SIZE;
	}

	// Build PDF
	return new Promise<Buffer>((resolve, reject) => {
		const doc = new PDFDocument({ size: "A4", margin: 50 });
		const chunks: Buffer[] = [];

		doc.on("data", (chunk: Buffer) => chunks.push(chunk));
		doc.on("end", () => resolve(Buffer.concat(chunks)));
		doc.on("error", reject);

		const fmt = (amount: number) => minorToDecimal(amount, currency);
		const pageWidth = doc.page.width - 100; // margins

		// --- Header ---
		doc.fontSize(20).font("Helvetica-Bold").text("Account Statement", { align: "center" });
		doc.moveDown(0.5);
		doc.fontSize(9).font("Helvetica").fillColor("#666666");
		doc.text(`Holder: ${holderId}    Account: ${account.id}`, { align: "center" });
		doc.text(
			`Period: ${dateFrom.slice(0, 10)} to ${dateTo.slice(0, 10)}    Currency: ${currency}`,
			{ align: "center" },
		);
		doc.moveDown(1);

		// --- Summary Box ---
		const summaryY = doc.y;
		doc.rect(50, summaryY, pageWidth, 70).fillAndStroke("#f8f9fa", "#e0e0e0");

		doc.fillColor("#333333").fontSize(10).font("Helvetica-Bold");
		doc.text("Opening Balance", 65, summaryY + 10);
		doc.text("Closing Balance", 200, summaryY + 10);
		doc.text("Total Credits", 335, summaryY + 10);
		doc.text("Total Debits", 460, summaryY + 10);

		doc.fontSize(12).font("Helvetica");
		doc.text(fmt(openingBalance), 65, summaryY + 28);
		doc.text(fmt(closingBalance), 200, summaryY + 28);
		doc.fillColor("#16a34a").text(fmt(aggregates.total_credits), 335, summaryY + 28);
		doc.fillColor("#dc2626").text(fmt(aggregates.total_debits), 460, summaryY + 28);

		doc.fillColor("#666666").fontSize(8).font("Helvetica");
		doc.text(
			`Net Change: ${fmt(aggregates.total_credits - aggregates.total_debits)}    Transactions: ${aggregates.transaction_count}    Entries: ${aggregates.entry_count}`,
			65,
			summaryY + 50,
		);

		doc.y = summaryY + 80;

		// --- Table Header ---
		const COL = { date: 50, ref: 130, desc: 220, type: 340, amount: 390, balance: 470 };

		function drawTableHeader() {
			const y = doc.y;
			doc.rect(50, y, pageWidth, 18).fill("#333333");
			doc.fillColor("#ffffff").fontSize(8).font("Helvetica-Bold");
			doc.text("Date", COL.date + 4, y + 4);
			doc.text("Reference", COL.ref + 4, y + 4);
			doc.text("Description", COL.desc + 4, y + 4);
			doc.text("Type", COL.type + 4, y + 4);
			doc.text("Amount", COL.amount + 4, y + 4);
			doc.text("Balance After", COL.balance + 4, y + 4);
			doc.fillColor("#333333").font("Helvetica");
			doc.y = y + 20;
		}

		drawTableHeader();

		// --- Table Rows ---
		for (let i = 0; i < allEntries.length; i++) {
			const entry = allEntries[i] as StatementEntry;

			// Check page break
			if (doc.y > doc.page.height - 80) {
				doc.addPage();
				drawTableHeader();
			}

			const y = doc.y;
			const isEven = i % 2 === 0;

			if (isEven) {
				doc.rect(50, y, pageWidth, 16).fill("#f8f9fa");
			}

			doc.fillColor("#333333").fontSize(7).font("Helvetica");
			doc.text(entry.date.slice(0, 10), COL.date + 4, y + 4, { width: 76 });
			doc.text(entry.transactionRef.slice(0, 14), COL.ref + 4, y + 4, { width: 86 });
			doc.text((entry.description ?? "").slice(0, 18), COL.desc + 4, y + 4, { width: 116 });

			const typeColor = entry.entryType === "CREDIT" ? "#16a34a" : "#dc2626";
			doc.fillColor(typeColor).font("Helvetica-Bold");
			doc.text(entry.entryType, COL.type + 4, y + 4, { width: 46 });

			doc.fillColor("#333333").font("Helvetica");
			doc.text(entry.amountDecimal, COL.amount + 4, y + 4, { width: 76 });
			doc.text(entry.balanceAfter != null ? fmt(entry.balanceAfter) : "-", COL.balance + 4, y + 4, {
				width: 76,
			});

			doc.y = y + 16;
		}

		// --- Footer ---
		doc.moveDown(1);
		doc.fillColor("#999999").fontSize(7).font("Helvetica");
		doc.text(
			`Generated on ${new Date().toISOString().slice(0, 10)} — Summa Financial Ledger`,
			50,
			doc.y,
			{ align: "center" },
		);

		doc.end();
	});
}

// =============================================================================
// STREAMING GENERATORS — Memory-bounded for large statements
// =============================================================================

/**
 * Stream a PDF statement as a Readable stream.
 * PDFKit already extends Readable — we write to it incrementally
 * and return it without collecting all chunks in memory.
 */
export async function generateStatementPdfStream(
	ctx: SummaContext,
	holderId: string,
	options?: { dateFrom?: string; dateTo?: string },
): Promise<InstanceType<typeof PDFDocument> | null> {
	const account = await resolveAccount(ctx, holderId);
	if (!account) return null;

	const now = new Date().toISOString();
	const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
	const dateFrom = resolveDate(options?.dateFrom, thirtyDaysAgo);
	const dateTo = resolveDate(options?.dateTo, now);
	const currency = account.currency;

	const [aggregates, openingBalance] = await Promise.all([
		queryAggregates(ctx, account.id, dateFrom, dateTo),
		queryOpeningBalance(ctx, account.id, dateFrom),
	]);

	const closingBalance = await queryClosingBalance(
		ctx,
		account.id,
		dateFrom,
		dateTo,
		openingBalance,
	);

	const doc = new PDFDocument({ size: "A4", margin: 50 });
	const fmt = (amount: number) => minorToDecimal(amount, currency);
	const pageWidth = doc.page.width - 100;

	// --- Header ---
	doc.fontSize(20).font("Helvetica-Bold").text("Account Statement", { align: "center" });
	doc.moveDown(0.5);
	doc.fontSize(9).font("Helvetica").fillColor("#666666");
	doc.text(`Holder: ${holderId}    Account: ${account.id}`, { align: "center" });
	doc.text(`Period: ${dateFrom.slice(0, 10)} to ${dateTo.slice(0, 10)}    Currency: ${currency}`, {
		align: "center",
	});
	doc.moveDown(1);

	// --- Summary Box ---
	const summaryY = doc.y;
	doc.rect(50, summaryY, pageWidth, 70).fillAndStroke("#f8f9fa", "#e0e0e0");
	doc.fillColor("#333333").fontSize(10).font("Helvetica-Bold");
	doc.text("Opening Balance", 65, summaryY + 10);
	doc.text("Closing Balance", 200, summaryY + 10);
	doc.text("Total Credits", 335, summaryY + 10);
	doc.text("Total Debits", 460, summaryY + 10);
	doc.fontSize(12).font("Helvetica");
	doc.text(fmt(openingBalance), 65, summaryY + 28);
	doc.text(fmt(closingBalance), 200, summaryY + 28);
	doc.fillColor("#16a34a").text(fmt(aggregates.total_credits), 335, summaryY + 28);
	doc.fillColor("#dc2626").text(fmt(aggregates.total_debits), 460, summaryY + 28);
	doc.fillColor("#666666").fontSize(8).font("Helvetica");
	doc.text(
		`Net Change: ${fmt(aggregates.total_credits - aggregates.total_debits)}    Transactions: ${aggregates.transaction_count}    Entries: ${aggregates.entry_count}`,
		65,
		summaryY + 50,
	);
	doc.y = summaryY + 80;

	// --- Table Header ---
	const COL = { date: 50, ref: 130, desc: 220, type: 340, amount: 390, balance: 470 };
	function drawTableHeader() {
		const y = doc.y;
		doc.rect(50, y, pageWidth, 18).fill("#333333");
		doc.fillColor("#ffffff").fontSize(8).font("Helvetica-Bold");
		doc.text("Date", COL.date + 4, y + 4);
		doc.text("Reference", COL.ref + 4, y + 4);
		doc.text("Description", COL.desc + 4, y + 4);
		doc.text("Type", COL.type + 4, y + 4);
		doc.text("Amount", COL.amount + 4, y + 4);
		doc.text("Balance After", COL.balance + 4, y + 4);
		doc.fillColor("#333333").font("Helvetica");
		doc.y = y + 20;
	}
	drawTableHeader();

	// --- Stream entries in batches (no allEntries array in memory) ---
	const BATCH_SIZE = 500;
	let batchOffset = 0;
	let rowIndex = 0;

	const writeEntries = async () => {
		while (true) {
			const batch = await queryEntries(ctx, account.id, dateFrom, dateTo, BATCH_SIZE, batchOffset);
			if (batch.length === 0) break;

			for (const row of batch) {
				const entry = mapEntryRow(row, currency);
				if (doc.y > doc.page.height - 80) {
					doc.addPage();
					drawTableHeader();
				}

				const y = doc.y;
				if (rowIndex % 2 === 0) {
					doc.rect(50, y, pageWidth, 16).fill("#f8f9fa");
				}

				doc.fillColor("#333333").fontSize(7).font("Helvetica");
				doc.text(entry.date.slice(0, 10), COL.date + 4, y + 4, { width: 76 });
				doc.text(entry.transactionRef.slice(0, 14), COL.ref + 4, y + 4, { width: 86 });
				doc.text((entry.description ?? "").slice(0, 18), COL.desc + 4, y + 4, { width: 116 });

				const typeColor = entry.entryType === "CREDIT" ? "#16a34a" : "#dc2626";
				doc.fillColor(typeColor).font("Helvetica-Bold");
				doc.text(entry.entryType, COL.type + 4, y + 4, { width: 46 });

				doc.fillColor("#333333").font("Helvetica");
				doc.text(entry.amountDecimal, COL.amount + 4, y + 4, { width: 76 });
				doc.text(
					entry.balanceAfter != null ? fmt(entry.balanceAfter) : "-",
					COL.balance + 4,
					y + 4,
					{ width: 76 },
				);

				doc.y = y + 16;
				rowIndex++;
			}

			if (batch.length < BATCH_SIZE) break;
			batchOffset += BATCH_SIZE;
		}

		// --- Footer ---
		doc.moveDown(1);
		doc.fillColor("#999999").fontSize(7).font("Helvetica");
		doc.text(
			`Generated on ${new Date().toISOString().slice(0, 10)} — Summa Financial Ledger`,
			50,
			doc.y,
			{ align: "center" },
		);
		doc.end();
	};

	// Start writing entries asynchronously — doc is a Readable stream the caller can pipe
	// biome-ignore lint/suspicious/noExplicitAny: PDFDocument extends Readable which has destroy()
	writeEntries().catch((err) => (doc as any).destroy(err));

	return doc;
}

/**
 * Stream CSV rows as an async generator.
 * Yields one string per row — caller can pipe to response without buffering.
 */
export async function* generateStatementCsvStream(
	ctx: SummaContext,
	holderId: string,
	options?: { dateFrom?: string; dateTo?: string },
): AsyncGenerator<string> {
	const account = await resolveAccount(ctx, holderId);
	if (!account) return;

	const now = new Date().toISOString();
	const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
	const dateFrom = resolveDate(options?.dateFrom, thirtyDaysAgo);
	const dateTo = resolveDate(options?.dateTo, now);
	const currency = account.currency;

	const [aggregates, openingBalance] = await Promise.all([
		queryAggregates(ctx, account.id, dateFrom, dateTo),
		queryOpeningBalance(ctx, account.id, dateFrom),
	]);

	const closingBalance = await queryClosingBalance(
		ctx,
		account.id,
		dateFrom,
		dateTo,
		openingBalance,
	);

	// Yield header lines
	yield "# Account Statement\n";
	yield `# Holder ID: ${holderId}\n`;
	yield `# Period: ${dateFrom} to ${dateTo}\n`;
	yield `# Currency: ${currency}\n`;
	yield `# Opening Balance: ${minorToDecimal(openingBalance, currency)}\n`;
	yield `# Closing Balance: ${minorToDecimal(closingBalance, currency)}\n`;
	yield `# Total Credits: ${minorToDecimal(aggregates.total_credits, currency)}\n`;
	yield `# Total Debits: ${minorToDecimal(aggregates.total_debits, currency)}\n`;
	yield `# Net Change: ${minorToDecimal(aggregates.total_credits - aggregates.total_debits, currency)}\n`;
	yield `# Transactions: ${aggregates.transaction_count}\n`;
	yield "#\n";
	yield "Date,Transaction Ref,Description,Entry Type,Amount,Amount (Decimal),Currency,Balance Before,Balance After\n";

	// Stream entries in batches
	const BATCH_SIZE = 500;
	let batchOffset = 0;

	while (true) {
		const batch = await queryEntries(ctx, account.id, dateFrom, dateTo, BATCH_SIZE, batchOffset);
		if (batch.length === 0) break;

		for (const row of batch) {
			const entry = mapEntryRow(row, currency);
			yield `${[
				entry.date,
				escapeCsvField(entry.transactionRef),
				escapeCsvField(entry.description ?? ""),
				entry.entryType,
				String(entry.amount),
				entry.amountDecimal,
				entry.currency,
				entry.balanceBefore != null ? String(entry.balanceBefore) : "",
				entry.balanceAfter != null ? String(entry.balanceAfter) : "",
			].join(",")}\n`;
		}

		if (batch.length < BATCH_SIZE) break;
		batchOffset += BATCH_SIZE;
	}
}

// =============================================================================
// ASYNC STATEMENT JOB TYPES
// =============================================================================

export type StatementJobStatus = "pending" | "processing" | "completed" | "failed";

export interface StatementJob {
	id: string;
	holderId: string;
	format: "csv" | "pdf";
	status: StatementJobStatus;
	dateFrom: string;
	dateTo: string;
	result: string | null;
	filename: string | null;
	error: string | null;
	createdAt: string;
	completedAt: string | null;
}

/** Raw row from statement_job — no longer contains status/error/completed_at columns */
interface RawStatementJobRow {
	id: string;
	holder_id: string;
	format: string;
	date_from: string;
	date_to: string;
	result: string | null;
	filename: string | null;
	created_at: string | Date;
}

/** Raw row when joining statement_job with entity_status_log for current status */
interface RawStatementJobWithStatusRow extends RawStatementJobRow {
	current_status: string;
	status_metadata: Record<string, unknown> | null;
}

function mapJobRow(row: RawStatementJobWithStatusRow): StatementJob {
	const meta = row.status_metadata ?? {};
	return {
		id: row.id,
		holderId: row.holder_id,
		format: row.format as "csv" | "pdf",
		status: row.current_status as StatementJobStatus,
		dateFrom: row.date_from,
		dateTo: row.date_to,
		result: row.result,
		filename: row.filename,
		error: (meta.error as string) ?? null,
		createdAt: typeof row.created_at === "string" ? row.created_at : row.created_at.toISOString(),
		completedAt: (meta.completed_at as string) ?? null,
	};
}

// =============================================================================
// ASYNC JOB QUERY FUNCTIONS
// =============================================================================

const ENTITY_TYPE = "statement_job";

async function createStatementJob(
	ctx: SummaContext,
	params: {
		holderId: string;
		format: "csv" | "pdf";
		dateFrom: string;
		dateTo: string;
	},
): Promise<StatementJob> {
	const id = randomUUID();
	const now = new Date().toISOString();
	const from = params.dateFrom.slice(0, 10);
	const to = params.dateTo.slice(0, 10);
	const filename = `statement-${params.holderId}-${from}-${to}.${params.format}`;

	const t = createTableResolver(ctx.options.schema);

	const job = await ctx.adapter.transaction(async (tx) => {
		const rows = await tx.raw<RawStatementJobRow>(
			`INSERT INTO ${t("statement_job")} (id, holder_id, format, date_from, date_to, filename, created_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7)
			 RETURNING *`,
			[id, params.holderId, params.format, params.dateFrom, params.dateTo, filename, now],
		);

		const row = rows[0];
		if (!row) throw new Error("INSERT INTO statement_job returned no rows");

		await initializeEntityStatus(tx, ENTITY_TYPE, id, "pending");

		return {
			...row,
			current_status: "pending" as const,
			status_metadata: null,
		} satisfies RawStatementJobWithStatusRow;
	});

	return mapJobRow(job);
}

async function getStatementJob(ctx: SummaContext, jobId: string): Promise<StatementJob | null> {
	const t = createTableResolver(ctx.options.schema);

	// Use LATERAL JOIN to entity_status_log to get current status
	const rows = await ctx.adapter.raw<RawStatementJobWithStatusRow>(
		`SELECT
			j.id,
			j.holder_id,
			j.format,
			j.date_from,
			j.date_to,
			j.result,
			j.filename,
			j.created_at,
			s.status AS current_status,
			s.metadata AS status_metadata
		FROM ${t("statement_job")} j
		LEFT JOIN LATERAL (
			SELECT status, metadata
			FROM ${t("entity_status_log")}
			WHERE entity_type = '${ENTITY_TYPE}' AND entity_id = j.id
			ORDER BY created_at DESC
			LIMIT 1
		) s ON true
		WHERE j.id = $1`,
		[jobId],
	);

	const row = rows[0];
	if (!row) return null;
	return mapJobRow(row);
}

async function processStatementJobs(ctx: SummaContext): Promise<number> {
	const d = ctx.dialect;
	const t = createTableResolver(ctx.options.schema);

	// Find up to 5 pending jobs using LATERAL JOIN to entity_status_log.
	// Lock the statement_job rows with FOR UPDATE SKIP LOCKED to prevent
	// concurrent workers from claiming the same jobs.
	const pendingJobs = await ctx.adapter.transaction(async (tx) => {
		const candidates = await tx.raw<RawStatementJobWithStatusRow>(
			`SELECT
				j.id,
				j.holder_id,
				j.format,
				j.date_from,
				j.date_to,
				j.result,
				j.filename,
				j.created_at,
				s.status AS current_status,
				s.metadata AS status_metadata
			FROM ${t("statement_job")} j
			INNER JOIN LATERAL (
				SELECT status, metadata
				FROM ${t("entity_status_log")}
				WHERE entity_type = '${ENTITY_TYPE}' AND entity_id = j.id
				ORDER BY created_at DESC
				LIMIT 1
			) s ON true
			WHERE s.status = 'pending'
			ORDER BY j.created_at ASC
			LIMIT 5
			${d.forUpdateSkipLocked()}`,
			[],
		);

		// Transition each claimed job to 'processing'
		for (const row of candidates) {
			await transitionEntityStatus({
				tx,
				entityType: ENTITY_TYPE,
				entityId: row.id,
				status: "processing",
				expectedCurrentStatus: "pending",
			});
		}

		return candidates;
	});

	let processed = 0;

	for (const row of pendingJobs) {
		const job = mapJobRow(row);
		try {
			let content: string;

			if (job.format === "csv") {
				const csv = await generateStatementCsv(ctx, job.holderId, {
					dateFrom: job.dateFrom,
					dateTo: job.dateTo,
				});
				if (!csv) {
					await ctx.adapter.transaction(async (tx) => {
						await transitionEntityStatus({
							tx,
							entityType: ENTITY_TYPE,
							entityId: job.id,
							status: "failed",
							expectedCurrentStatus: "processing",
							metadata: {
								error: "Account not found",
								completed_at: new Date().toISOString(),
							},
						});
					});
					continue;
				}
				content = csv;
			} else {
				const pdf = await generateStatementPdf(ctx, job.holderId, {
					dateFrom: job.dateFrom,
					dateTo: job.dateTo,
				});
				if (!pdf) {
					await ctx.adapter.transaction(async (tx) => {
						await transitionEntityStatus({
							tx,
							entityType: ENTITY_TYPE,
							entityId: job.id,
							status: "failed",
							expectedCurrentStatus: "processing",
							metadata: {
								error: "Account not found",
								completed_at: new Date().toISOString(),
							},
						});
					});
					continue;
				}
				content = pdf.toString("base64");
			}

			await ctx.adapter.transaction(async (tx) => {
				// Store the result content on the statement_job row
				await tx.rawMutate(`UPDATE ${t("statement_job")} SET result = $1 WHERE id = $2`, [
					content,
					job.id,
				]);

				await transitionEntityStatus({
					tx,
					entityType: ENTITY_TYPE,
					entityId: job.id,
					status: "completed",
					expectedCurrentStatus: "processing",
					metadata: {
						completed_at: new Date().toISOString(),
					},
				});
			});
			processed++;
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			try {
				await ctx.adapter.transaction(async (tx) => {
					await transitionEntityStatus({
						tx,
						entityType: ENTITY_TYPE,
						entityId: job.id,
						status: "failed",
						expectedCurrentStatus: "processing",
						metadata: {
							error: errorMsg.slice(0, 1000),
							completed_at: new Date().toISOString(),
						},
					});
				});
			} catch {
				// If we can't even record the failure, log and move on
			}
		}
	}

	return processed;
}

// =============================================================================
// PLUGIN FACTORY
// =============================================================================

export function statements(options?: StatementOptions): SummaPlugin {
	const prefix = options?.basePath ?? "/statements";

	const endpoints: PluginEndpoint[] = [
		// Summary-only endpoint (must be before the general one)
		{
			method: "GET",
			path: `${prefix}/:holderId/summary`,
			handler: async (req, ctx) => {
				const holderId = req.params.holderId ?? "";
				if (!holderId) return json(400, { error: "holderId is required" });

				const summary = await getStatementSummary(ctx, holderId, {
					dateFrom: req.query.dateFrom,
					dateTo: req.query.dateTo,
				});

				if (!summary) return json(404, { error: "Account not found" });
				return json(200, summary);
			},
		},

		// --- Async job endpoints ---

		// Submit a background statement generation job (CSV or PDF)
		{
			method: "POST",
			path: `${prefix}/:holderId/generate`,
			handler: async (req, ctx) => {
				const holderId = req.params.holderId ?? "";
				if (!holderId) return json(400, { error: "holderId is required" });

				const body = req.body as { format?: string; dateFrom?: string; dateTo?: string } | null;
				const format = body?.format ?? "csv";
				if (format !== "csv" && format !== "pdf") {
					return json(400, { error: "format must be 'csv' or 'pdf'" });
				}

				// Verify account exists before creating job
				const account = await resolveAccount(ctx, holderId);
				if (!account) return json(404, { error: "Account not found" });

				const now = new Date().toISOString();
				const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
				const dateFrom = body?.dateFrom ?? thirtyDaysAgo;
				const dateTo = body?.dateTo ?? now;

				const job = await createStatementJob(ctx, {
					holderId,
					format,
					dateFrom,
					dateTo,
				});

				return json(202, {
					jobId: job.id,
					status: job.status,
					pollUrl: `${prefix}/jobs/${job.id}`,
				});
			},
		},

		// Poll job status / download result
		{
			method: "GET",
			path: `${prefix}/jobs/:jobId`,
			handler: async (req, ctx) => {
				const jobId = req.params.jobId ?? "";
				if (!jobId) return json(400, { error: "jobId is required" });

				const job = await getStatementJob(ctx, jobId);
				if (!job) return json(404, { error: "Job not found" });

				if (job.status === "completed") {
					return json(200, {
						jobId: job.id,
						status: job.status,
						format: job.format,
						filename: job.filename,
						content: job.result,
						completedAt: job.completedAt,
					});
				}

				if (job.status === "failed") {
					return json(200, {
						jobId: job.id,
						status: job.status,
						error: job.error,
						completedAt: job.completedAt,
					});
				}

				// pending or processing
				return json(200, {
					jobId: job.id,
					status: job.status,
					createdAt: job.createdAt,
				});
			},
		},

		// Full statement endpoint (JSON remains synchronous — it's paginated and fast)
		{
			method: "GET",
			path: `${prefix}/:holderId`,
			handler: async (req, ctx) => {
				const holderId = req.params.holderId ?? "";
				if (!holderId) return json(400, { error: "holderId is required" });

				const format = req.query.format ?? "json";
				const dateOpts = {
					dateFrom: req.query.dateFrom,
					dateTo: req.query.dateTo,
				};

				// Synchronous CSV/PDF — for large statements, use POST /:holderId/generate
				// or the streaming functions (generateStatementPdfStream / generateStatementCsvStream).
				if (format === "csv") {
					const csv = await generateStatementCsv(ctx, holderId, dateOpts);
					if (!csv) return json(404, { error: "Account not found" });

					const from = (req.query.dateFrom ?? "start").slice(0, 10);
					const to = (req.query.dateTo ?? "now").slice(0, 10);

					return {
						status: 200,
						body: {
							format: "csv",
							filename: `statement-${holderId}-${from}-${to}.csv`,
							content: csv,
						},
					};
				}

				if (format === "pdf") {
					const pdf = await generateStatementPdf(ctx, holderId, dateOpts);
					if (!pdf) return json(404, { error: "Account not found" });

					const from = (req.query.dateFrom ?? "start").slice(0, 10);
					const to = (req.query.dateTo ?? "now").slice(0, 10);

					return {
						status: 200,
						body: {
							format: "pdf",
							filename: `statement-${holderId}-${from}-${to}.pdf`,
							content: pdf.toString("base64"),
						},
					};
				}

				const result = await getAccountStatement(ctx, holderId, {
					dateFrom: req.query.dateFrom,
					dateTo: req.query.dateTo,
					page: req.query.page ? Number(req.query.page) : undefined,
					perPage: req.query.perPage ? Number(req.query.perPage) : undefined,
				});

				if (!result) return json(404, { error: "Account not found" });
				return json(200, result);
			},
		},
	];

	return {
		id: "statements",
		$Infer: {} as {
			StatementEntry: StatementEntry;
			StatementSummary: StatementSummary;
			StatementResult: StatementResult;
			StatementJob: StatementJob;
		},
		endpoints,

		// Schema for the statement_job table — status is tracked via entity_status_log
		schema: {
			statement_job: {
				columns: {
					id: { type: "uuid", primaryKey: true, notNull: true },
					holder_id: { type: "text", notNull: true },
					format: { type: "text", notNull: true },
					date_from: { type: "text", notNull: true },
					date_to: { type: "text", notNull: true },
					result: { type: "text" },
					filename: { type: "text" },
					created_at: { type: "timestamp", notNull: true },
				},
				indexes: [{ name: "idx_statement_job_holder", columns: ["holder_id"] }],
			},
		},

		// Background worker to process statement generation jobs
		workers: [
			{
				id: "statement-generator",
				description: "Processes pending statement generation jobs (CSV/PDF)",
				interval: "5s",
				leaseRequired: true,
				handler: async (ctx) => {
					const processed = await processStatementJobs(ctx);
					if (processed > 0) {
						ctx.logger.info("Statement generator processed jobs", { count: processed });
					}
				},
			},
		],
	};
}
