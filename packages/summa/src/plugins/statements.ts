// =============================================================================
// STATEMENTS PLUGIN — Account statement generation with CSV/JSON download
// =============================================================================
// Read-only plugin that generates account statements for any date range.
// Combines entry_record and transaction_record data to produce line-item
// statements with computed summaries (opening/closing balance, totals).
//
// No new tables required — queries existing entry_record, transaction_record,
// and account_balance tables.

import type { PluginApiResponse, PluginEndpoint, SummaContext, SummaPlugin } from "@summa/core";
import { minorToDecimal } from "@summa/core";

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
	if (value.includes(",") || value.includes('"') || value.includes("\n")) {
		return `"${value.replace(/"/g, '""')}"`;
	}
	return value;
}

function resolveDate(date: string | undefined, fallback: string): string {
	return date ?? fallback;
}

async function resolveAccount(
	ctx: SummaContext,
	holderId: string,
): Promise<{ id: string; currency: string } | null> {
	const rows = await ctx.adapter.raw<{ id: string; currency: string }>(
		"SELECT id, currency FROM account_balance WHERE holder_id = $1 LIMIT 1",
		[holderId],
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
	return ctx.adapter.raw<RawEntryRow>(
		`SELECT
			e.id            AS entry_id,
			e.transaction_id,
			t.reference     AS transaction_ref,
			t.description,
			e.entry_type,
			e.amount,
			e.currency,
			e.balance_before,
			e.balance_after,
			e.created_at
		FROM entry_record e
		JOIN transaction_record t ON t.id = e.transaction_id
		WHERE e.account_id = $1
			AND e.created_at >= $2::timestamptz
			AND e.created_at < $3::timestamptz
		ORDER BY e.created_at ASC, e.id ASC
		LIMIT $4 OFFSET $5`,
		[accountId, dateFrom, dateTo, limit, offset],
	);
}

async function queryEntryCount(
	ctx: SummaContext,
	accountId: string,
	dateFrom: string,
	dateTo: string,
): Promise<number> {
	const rows = await ctx.adapter.raw<RawCountRow>(
		`SELECT COUNT(*)::int AS cnt
		FROM entry_record e
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
	const rows = await ctx.adapter.raw<RawSummaryRow>(
		`SELECT
			COALESCE(SUM(CASE WHEN e.entry_type = 'CREDIT' THEN e.amount ELSE 0 END), 0)::bigint AS total_credits,
			COALESCE(SUM(CASE WHEN e.entry_type = 'DEBIT'  THEN e.amount ELSE 0 END), 0)::bigint AS total_debits,
			COUNT(DISTINCT e.transaction_id)::int AS transaction_count,
			COUNT(*)::int AS entry_count
		FROM entry_record e
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
	const rows = await ctx.adapter.raw<RawBalanceRow>(
		`SELECT e.balance_after
		FROM entry_record e
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
	const rows = await ctx.adapter.raw<RawBalanceRow>(
		`SELECT e.balance_after
		FROM entry_record e
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
		// Full statement endpoint
		{
			method: "GET",
			path: `${prefix}/:holderId`,
			handler: async (req, ctx) => {
				const holderId = req.params.holderId ?? "";
				if (!holderId) return json(400, { error: "holderId is required" });

				const format = req.query.format ?? "json";

				if (format === "csv") {
					const csv = await generateStatementCsv(ctx, holderId, {
						dateFrom: req.query.dateFrom,
						dateTo: req.query.dateTo,
					});

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
		},
		endpoints,
	};
}
