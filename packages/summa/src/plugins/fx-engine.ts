// =============================================================================
// FX ENGINE PLUGIN -- Foreign exchange rates, quotes, and gain/loss tracking
// =============================================================================

import type {
	PluginApiRequest,
	PluginApiResponse,
	SummaContext,
	SummaPlugin,
} from "@summa-ledger/core";
import { SummaError } from "@summa-ledger/core";
import { createTableResolver } from "@summa-ledger/core/db";
import { initializeEntityStatus, transitionEntityStatus } from "../infrastructure/entity-status.js";

// =============================================================================
// TYPES
// =============================================================================

export interface FxRateProvider {
	getRate(
		from: string,
		to: string,
		date?: Date,
	): Promise<{ rate: number; inverse: number; timestamp: Date }>;
}

export interface FxEngineOptions {
	rateProvider: FxRateProvider;
	/** Cache TTL in milliseconds. Default: 300000 (5 min) */
	cacheTtlMs?: number;
	/** Quote expiry in milliseconds. Default: 300000 (5 min) */
	quoteExpiryMs?: number;
}

export interface FxRate {
	from: string;
	to: string;
	/** Exchange rate as scaled integer (rate * 1_000_000 for 6 decimal precision). E.g. 0.92 → 920_000 */
	rate: number;
	/** Inverse rate as scaled integer */
	inverse: number;
	timestamp: string;
}

export interface FxQuote {
	id: string;
	from: string;
	to: string;
	/** Exchange rate as scaled integer (rate * 1_000_000) */
	rate: number;
	fromAmount: number;
	toAmount: number;
	expiresAt: string;
	status: "active" | "used" | "expired";
}

/** Scale factor for exchange rate integer representation (6 decimal precision) */
const FX_SCALE = 1_000_000;

/** Entity type constant for fx_rate_quote status tracking */
const ENTITY_TYPE = "fx_rate_quote";

/** Convert a decimal rate (e.g. 0.92) to scaled integer (920_000) */
function toScaledRate(decimal: number): number {
	return Math.round(decimal * FX_SCALE);
}

function jsonRes(status: number, body: unknown): PluginApiResponse {
	return { status, body };
}

// =============================================================================
// CORE OPERATIONS
// =============================================================================

export async function getRate(
	ctx: SummaContext,
	provider: FxRateProvider,
	from: string,
	to: string,
	cacheTtlMs: number,
): Promise<FxRate> {
	const t = createTableResolver(ctx.options.schema);

	// Check cache first
	const cached = await ctx.adapter.raw<{
		rate: number;
		inverse: number;
		fetched_at: string | Date;
		valid_until: string | Date;
	}>(
		`SELECT rate, inverse, fetched_at, valid_until FROM ${t("fx_rate_cache")}
     WHERE from_currency = $1 AND to_currency = $2 AND valid_until > NOW()
     LIMIT 1`,
		[from, to],
	);

	if (cached[0]) {
		return {
			from,
			to,
			rate: Number(cached[0].rate),
			inverse: Number(cached[0].inverse),
			timestamp:
				cached[0].fetched_at instanceof Date
					? cached[0].fetched_at.toISOString()
					: String(cached[0].fetched_at),
		};
	}

	// Fetch from provider (returns decimal rates) and convert to scaled integers
	const fetched = await provider.getRate(from, to);
	const scaledRate = toScaledRate(fetched.rate);
	const scaledInverse = toScaledRate(fetched.inverse);
	const validUntil = new Date(Date.now() + cacheTtlMs);

	// Upsert cache — store as scaled integers (bigint-safe)
	await ctx.adapter.raw(
		`INSERT INTO ${t("fx_rate_cache")} (from_currency, to_currency, rate, inverse, fetched_at, valid_until)
     VALUES ($1, $2, $3, $4, NOW(), $5)
     ON CONFLICT (from_currency, to_currency)
     DO UPDATE SET rate = $3, inverse = $4, fetched_at = NOW(), valid_until = $5`,
		[from, to, scaledRate, scaledInverse, validUntil.toISOString()],
	);

	return {
		from,
		to,
		rate: scaledRate,
		inverse: scaledInverse,
		timestamp: fetched.timestamp.toISOString(),
	};
}

export async function createRateQuote(
	ctx: SummaContext,
	provider: FxRateProvider,
	params: { from: string; to: string; amount: number },
	cacheTtlMs: number,
	quoteExpiryMs: number,
): Promise<FxQuote> {
	const t = createTableResolver(ctx.options.schema);
	const rate = await getRate(ctx, provider, params.from, params.to, cacheTtlMs);
	// rate.rate is a scaled integer (e.g. 920_000 for 0.92) — same formula as transfer()
	const toAmount = Math.round(params.amount * (rate.rate / FX_SCALE));
	const expiresAt = new Date(Date.now() + quoteExpiryMs);

	const rows = await ctx.adapter.raw<{
		id: string;
		expires_at: string | Date;
		created_at: string | Date;
	}>(
		`INSERT INTO ${t("fx_rate_quote")} (from_currency, to_currency, rate, from_amount, to_amount, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, expires_at, created_at`,
		[params.from, params.to, rate.rate, params.amount, toAmount, expiresAt.toISOString()],
	);

	const row = rows[0];
	if (!row) throw SummaError.internal("Failed to create FX quote");

	// Initialize entity status in entity_status_log
	await initializeEntityStatus(ctx.adapter, ENTITY_TYPE, row.id, "active");

	return {
		id: row.id,
		from: params.from,
		to: params.to,
		rate: rate.rate,
		fromAmount: params.amount,
		toAmount,
		expiresAt: expiresAt.toISOString(),
		status: "active",
	};
}

// =============================================================================
// PLUGIN FACTORY
// =============================================================================

export function fxEngine(options: FxEngineOptions): SummaPlugin {
	const { rateProvider, cacheTtlMs = 300_000, quoteExpiryMs = 300_000 } = options;

	return {
		id: "fx-engine",

		init: (ctx) => {
			ctx.fxResolver = async (from: string, to: string): Promise<number> => {
				const fxRate = await getRate(ctx, rateProvider, from, to, cacheTtlMs);
				return fxRate.rate;
			};
		},

		schema: {
			fx_rate_cache: {
				columns: {
					id: { type: "uuid", primaryKey: true },
					from_currency: { type: "text", notNull: true },
					to_currency: { type: "text", notNull: true },
					rate: { type: "bigint", notNull: true },
					inverse: { type: "bigint", notNull: true },
					fetched_at: { type: "timestamp", notNull: true },
					valid_until: { type: "timestamp", notNull: true },
				},
				indexes: [
					{
						name: "uq_fx_rate_cache_pair",
						columns: ["from_currency", "to_currency"],
						unique: true,
					},
				],
			},
			fx_rate_quote: {
				columns: {
					id: { type: "uuid", primaryKey: true },
					from_currency: { type: "text", notNull: true },
					to_currency: { type: "text", notNull: true },
					rate: { type: "bigint", notNull: true },
					from_amount: { type: "bigint", notNull: true },
					to_amount: { type: "bigint", notNull: true },
					expires_at: { type: "timestamp", notNull: true },
					created_at: { type: "timestamp", default: "NOW()" },
				},
				indexes: [],
			},
			fx_gain_loss: {
				columns: {
					id: { type: "uuid", primaryKey: true },
					transaction_id: { type: "uuid", notNull: true },
					account_id: { type: "uuid" },
					type: { type: "text", notNull: true },
					amount: { type: "bigint", notNull: true },
					currency: { type: "text", notNull: true },
					original_rate: { type: "bigint", notNull: true },
					current_rate: { type: "bigint", notNull: true },
					created_at: { type: "timestamp", default: "NOW()" },
				},
				indexes: [
					{ name: "idx_fx_gain_loss_txn", columns: ["transaction_id"] },
					{ name: "idx_fx_gain_loss_type", columns: ["type"] },
				],
			},
		},

		workers: [
			{
				id: "fx-quote-cleanup",
				description: "Expire old FX quotes",
				interval: "5m",
				leaseRequired: false,
				handler: async (ctx) => {
					const t = createTableResolver(ctx.options.schema);

					// Find active quotes that have expired using LATERAL JOIN to entity_status_log
					const expired = await ctx.adapter.raw<{ id: string }>(
						`SELECT q.id
						 FROM ${t("fx_rate_quote")} q
						 INNER JOIN LATERAL (
						   SELECT esl.status
						   FROM ${t("entity_status_log")} esl
						   WHERE esl.entity_type = '${ENTITY_TYPE}'
						     AND esl.entity_id = q.id::text
						   ORDER BY esl.created_at DESC
						   LIMIT 1
						 ) latest_status ON latest_status.status = 'active'
						 WHERE q.expires_at < NOW()`,
						[],
					);

					for (const row of expired) {
						await transitionEntityStatus({
							tx: ctx.adapter,
							entityType: ENTITY_TYPE,
							entityId: row.id,
							status: "expired",
							expectedCurrentStatus: "active",
							reason: "Quote expired",
						});
					}
				},
			},
		],

		hooks: {
			afterTransaction: async (params) => {
				if (params.type !== "transfer") return;
				const ctx = params.ctx;
				const t = createTableResolver(ctx.options.schema);

				// Look for cross-currency metadata on the transaction
				// The transfer function stores fxRate info in transaction metadata
				const meta = (params as unknown as { metadata?: Record<string, unknown> }).metadata;
				if (
					!meta?.crossCurrency ||
					!meta?.exchangeRate ||
					!meta?.originalCurrency ||
					!meta?.targetCurrency
				)
					return;

				// meta.exchangeRate is already a scaled integer from transfer()
				const originalRate = Number(meta.exchangeRate);
				const fromCurrency = String(meta.originalCurrency);
				const toCurrency = String(meta.targetCurrency);

				// Fetch current rate (also scaled integer) to compute gain/loss
				try {
					const currentRateObj = await getRate(
						ctx,
						rateProvider,
						fromCurrency,
						toCurrency,
						cacheTtlMs,
					);
					const currentRate = currentRateObj.rate;
					const amount = params.amount;

					// Both rates are scaled integers — ratio cancels out the scale factor
					// gain/loss = amount * (currentRate - originalRate) / originalRate
					const gainLossRaw = (amount * (currentRate - originalRate)) / originalRate;
					const gainLoss = Math.round(gainLossRaw);
					if (gainLoss === 0) return;

					const glType = gainLoss > 0 ? "gain" : "loss";

					await ctx.adapter.rawMutate(
						`INSERT INTO ${t("fx_gain_loss")} (id, transaction_id, type, amount, currency, original_rate, current_rate)
						 VALUES (${ctx.dialect.generateUuid()}, $1, $2, $3, $4, $5, $6)`,
						[
							meta.transactionId ?? params.reference,
							glType,
							Math.abs(gainLoss),
							toCurrency,
							originalRate,
							currentRate,
						],
					);
				} catch (err) {
					ctx.logger.warn("FX gain/loss calculation failed", { error: String(err) });
				}
			},
		},

		endpoints: [
			{
				method: "GET",
				path: "/fx/rate",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const { from, to } = req.query;
					if (!from || !to) {
						return jsonRes(400, {
							error: { code: "VALIDATION_ERROR", message: "from and to query params required" },
						});
					}
					const rate = await getRate(ctx, rateProvider, from, to, cacheTtlMs);
					return jsonRes(200, rate);
				},
			},
			{
				method: "POST",
				path: "/fx/quote",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const body = req.body as { from: string; to: string; amount: number };
					if (!body.from || !body.to || !body.amount) {
						return jsonRes(400, {
							error: { code: "VALIDATION_ERROR", message: "from, to, amount required" },
						});
					}
					const quote = await createRateQuote(ctx, rateProvider, body, cacheTtlMs, quoteExpiryMs);
					return jsonRes(201, quote);
				},
			},
			{
				method: "POST",
				path: "/fx/quote/:id/use",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const quoteId = req.params.id ?? "";
					const t = createTableResolver(ctx.options.schema);

					// Fetch quote with current status via LATERAL JOIN to entity_status_log
					const quotes = await ctx.adapter.raw<{
						id: string;
						from_currency: string;
						to_currency: string;
						rate: number;
						from_amount: number;
						to_amount: number;
						current_status: string;
						expires_at: string | Date;
					}>(
						`SELECT q.id, q.from_currency, q.to_currency, q.rate,
						        q.from_amount, q.to_amount, q.expires_at,
						        latest_status.status AS current_status
						 FROM ${t("fx_rate_quote")} q
						 INNER JOIN LATERAL (
						   SELECT esl.status
						   FROM ${t("entity_status_log")} esl
						   WHERE esl.entity_type = '${ENTITY_TYPE}'
						     AND esl.entity_id = q.id::text
						   ORDER BY esl.created_at DESC
						   LIMIT 1
						 ) latest_status ON true
						 WHERE q.id = $1
						 LIMIT 1`,
						[quoteId],
					);

					const quote = quotes[0];
					if (!quote)
						return jsonRes(404, { error: { code: "NOT_FOUND", message: "Quote not found" } });
					if (quote.current_status === "used")
						return jsonRes(409, { error: { code: "ALREADY_USED", message: "Quote already used" } });
					if (quote.current_status === "expired")
						return jsonRes(410, { error: { code: "EXPIRED", message: "Quote has expired" } });

					// Mark as used via entity_status_log; used_at goes in metadata
					await transitionEntityStatus({
						tx: ctx.adapter,
						entityType: ENTITY_TYPE,
						entityId: quoteId,
						status: "used",
						expectedCurrentStatus: "active",
						metadata: { used_at: new Date().toISOString() },
					});

					// Record gain/loss by comparing quote rate to current rate (both scaled integers)
					const originalRate = Number(quote.rate);
					try {
						const current = await getRate(
							ctx,
							rateProvider,
							quote.from_currency,
							quote.to_currency,
							cacheTtlMs,
						);
						// Both rates are scaled integers — ratio cancels out the scale factor
						const gainLossRaw =
							(Number(quote.from_amount) * (current.rate - originalRate)) / originalRate;
						const gainLoss = Math.round(gainLossRaw);

						if (gainLoss !== 0) {
							const glType = gainLoss > 0 ? "gain" : "loss";
							await ctx.adapter.rawMutate(
								`INSERT INTO ${t("fx_gain_loss")} (id, transaction_id, type, amount, currency, original_rate, current_rate)
								 VALUES (${ctx.dialect.generateUuid()}, $1, $2, $3, $4, $5, $6)`,
								[
									quoteId,
									glType,
									Math.abs(gainLoss),
									quote.to_currency,
									originalRate,
									current.rate,
								],
							);
						}
					} catch (err) {
						ctx.logger.warn("FX gain/loss on quote use failed", { error: String(err) });
					}

					return jsonRes(200, {
						id: quote.id,
						from: quote.from_currency,
						to: quote.to_currency,
						rate: originalRate,
						fromAmount: Number(quote.from_amount),
						toAmount: Number(quote.to_amount),
						status: "used",
					});
				},
			},
			{
				method: "GET",
				path: "/fx/gain-loss",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const t = createTableResolver(ctx.options.schema);
					const limit = req.query.limit ? Number(req.query.limit) : 50;
					const offset = req.query.offset ? Number(req.query.offset) : 0;

					const rows = await ctx.adapter.raw<{
						id: string;
						transaction_id: string;
						account_id: string | null;
						type: string;
						amount: number;
						currency: string;
						original_rate: number;
						current_rate: number;
						created_at: string | Date;
					}>(`SELECT * FROM ${t("fx_gain_loss")} ORDER BY created_at DESC LIMIT $1 OFFSET $2`, [
						limit,
						offset,
					]);

					return jsonRes(200, {
						entries: rows.map((r) => ({
							id: r.id,
							transactionId: r.transaction_id,
							accountId: r.account_id,
							type: r.type,
							amount: Number(r.amount),
							currency: r.currency,
							originalRate: Number(r.original_rate),
							currentRate: Number(r.current_rate),
							createdAt:
								r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
						})),
					});
				},
			},
		],
	};
}
