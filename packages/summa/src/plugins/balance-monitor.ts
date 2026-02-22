// =============================================================================
// BALANCE MONITOR PLUGIN -- Condition-based balance alerts
// =============================================================================
// Monitor account balances against thresholds and trigger events when conditions
// are met. Supports operators: gt, lt, gte, lte, eq. Integrates with outbox
// and outbox (with webhooks) for notifications.

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

export interface BalanceMonitorOptions {
	/** Cache TTL for monitors in seconds. Default: 300 (5 minutes) */
	cacheTtlSeconds?: number;
}

export type MonitorOperator = "gt" | "lt" | "gte" | "lte" | "eq";

export type MonitorField =
	| "balance"
	| "credit_balance"
	| "debit_balance"
	| "pending_credit"
	| "pending_debit";

export interface BalanceMonitorRecord {
	id: string;
	accountId: string;
	holderId: string;
	field: MonitorField;
	operator: MonitorOperator;
	threshold: number;
	description: string | null;
	active: boolean;
	lastTriggeredAt: string | null;
	createdAt: string;
}

// =============================================================================
// RAW ROWS
// =============================================================================

interface RawMonitorRow {
	id: string;
	ledger_id: string;
	account_id: string;
	holder_id: string;
	field: string;
	operator: string;
	threshold: number | string;
	description: string | null;
	active: boolean;
	last_triggered_at: string | Date | null;
	created_at: string | Date;
}

interface RawBalanceRow {
	balance: number | string;
	credit_balance: number | string;
	debit_balance: number | string;
	pending_credit: number | string;
	pending_debit: number | string;
}

// =============================================================================
// HELPERS
// =============================================================================

function toIso(val: string | Date | null): string | null {
	if (!val) return null;
	return val instanceof Date ? val.toISOString() : String(val);
}

function rawToMonitor(row: RawMonitorRow): BalanceMonitorRecord {
	return {
		id: row.id,
		accountId: row.account_id,
		holderId: row.holder_id,
		field: row.field as MonitorField,
		operator: row.operator as MonitorOperator,
		threshold: Number(row.threshold),
		description: row.description,
		active: row.active,
		lastTriggeredAt: toIso(row.last_triggered_at),
		createdAt: toIso(row.created_at)!,
	};
}

function json(status: number, body: unknown): PluginApiResponse {
	return { status, body };
}

function checkCondition(value: number, operator: MonitorOperator, threshold: number): boolean {
	switch (operator) {
		case "gt":
			return value > threshold;
		case "lt":
			return value < threshold;
		case "gte":
			return value >= threshold;
		case "lte":
			return value <= threshold;
		case "eq":
			return value === threshold;
		default:
			return false;
	}
}

// =============================================================================
// IN-MEMORY CACHE
// =============================================================================

interface CacheEntry {
	monitors: RawMonitorRow[];
	expiresAt: number;
}

const monitorCache = new Map<string, CacheEntry>();

function getCachedMonitors(accountId: string, _ttlMs: number): RawMonitorRow[] | null {
	const entry = monitorCache.get(accountId);
	if (!entry || Date.now() > entry.expiresAt) {
		monitorCache.delete(accountId);
		return null;
	}
	return entry.monitors;
}

function setCachedMonitors(accountId: string, monitors: RawMonitorRow[], ttlMs: number): void {
	monitorCache.set(accountId, { monitors, expiresAt: Date.now() + ttlMs });

	// Evict old entries if cache grows too large
	if (monitorCache.size > 10000) {
		const now = Date.now();
		for (const [key, entry] of monitorCache) {
			if (now > entry.expiresAt) monitorCache.delete(key);
		}
	}
}

// =============================================================================
// SCHEMA
// =============================================================================

const monitorSchema: Record<string, TableDefinition> = {
	balance_monitor: {
		columns: {
			id: { type: "uuid", primaryKey: true, notNull: true },
			ledger_id: { type: "uuid", notNull: true },
			account_id: { type: "uuid", notNull: true },
			holder_id: { type: "text", notNull: true },
			field: { type: "text", notNull: true },
			operator: { type: "text", notNull: true },
			threshold: { type: "bigint", notNull: true },
			description: { type: "text" },
			active: { type: "boolean", notNull: true, default: "true" },
			last_triggered_at: { type: "timestamp" },
			created_at: { type: "timestamp", notNull: true, default: "NOW()" },
		},
		indexes: [
			{ name: "idx_balance_monitor_account", columns: ["account_id"] },
			{ name: "idx_balance_monitor_holder", columns: ["holder_id"] },
			{ name: "idx_balance_monitor_active", columns: ["account_id", "active"] },
		],
	},
};

// =============================================================================
// CORE OPERATIONS
// =============================================================================

export async function createMonitor(
	ctx: SummaContext,
	params: {
		holderId: string;
		field: MonitorField;
		operator: MonitorOperator;
		threshold: number;
		description?: string;
	},
): Promise<BalanceMonitorRecord> {
	const t = createTableResolver(ctx.options.schema);
	const d = ctx.dialect;
	const ledgerId = getLedgerId(ctx);

	// Resolve account ID from holder ID
	const accounts = await ctx.adapter.raw<{ id: string }>(
		`SELECT id FROM ${t("account_balance")} WHERE holder_id = $1 AND ledger_id = $2 LIMIT 1`,
		[params.holderId, ledgerId],
	);
	const account = accounts[0];
	if (!account) throw SummaError.notFound("Account not found for holder");

	const rows = await ctx.adapter.raw<RawMonitorRow>(
		`INSERT INTO ${t("balance_monitor")} (
			id, ledger_id, account_id, holder_id, field, operator, threshold, description, created_at
		) VALUES (
			${d.generateUuid()}, $1, $2, $3, $4, $5, $6, $7, ${d.now()}
		) RETURNING *`,
		[
			ledgerId,
			account.id,
			params.holderId,
			params.field,
			params.operator,
			params.threshold,
			params.description ?? null,
		],
	);

	const row = rows[0];
	if (!row) throw SummaError.internal("Failed to create balance monitor");

	// Invalidate cache
	monitorCache.delete(account.id);

	return rawToMonitor(row);
}

export async function listMonitors(
	ctx: SummaContext,
	params?: { holderId?: string; activeOnly?: boolean },
): Promise<BalanceMonitorRecord[]> {
	const t = createTableResolver(ctx.options.schema);
	const ledgerId = getLedgerId(ctx);

	const conditions: string[] = ["ledger_id = $1"];
	const queryParams: unknown[] = [ledgerId];
	let idx = 2;

	if (params?.holderId) {
		conditions.push(`holder_id = $${idx++}`);
		queryParams.push(params.holderId);
	}
	if (params?.activeOnly !== false) {
		conditions.push("active = true");
	}

	const rows = await ctx.adapter.raw<RawMonitorRow>(
		`SELECT * FROM ${t("balance_monitor")}
		 WHERE ${conditions.join(" AND ")}
		 ORDER BY created_at DESC`,
		queryParams,
	);

	return rows.map(rawToMonitor);
}

export async function updateMonitor(
	ctx: SummaContext,
	monitorId: string,
	params: Partial<{
		field: MonitorField;
		operator: MonitorOperator;
		threshold: number;
		description: string;
		active: boolean;
	}>,
): Promise<BalanceMonitorRecord> {
	const t = createTableResolver(ctx.options.schema);
	const ledgerId = getLedgerId(ctx);

	const sets: string[] = [];
	const queryParams: unknown[] = [];
	let idx = 1;

	if (params.field !== undefined) {
		sets.push(`field = $${idx++}`);
		queryParams.push(params.field);
	}
	if (params.operator !== undefined) {
		sets.push(`operator = $${idx++}`);
		queryParams.push(params.operator);
	}
	if (params.threshold !== undefined) {
		sets.push(`threshold = $${idx++}`);
		queryParams.push(params.threshold);
	}
	if (params.description !== undefined) {
		sets.push(`description = $${idx++}`);
		queryParams.push(params.description);
	}
	if (params.active !== undefined) {
		sets.push(`active = $${idx++}`);
		queryParams.push(params.active);
	}

	if (sets.length === 0) throw SummaError.invalidArgument("No fields to update");

	queryParams.push(monitorId, ledgerId);

	const rows = await ctx.adapter.raw<RawMonitorRow>(
		`UPDATE ${t("balance_monitor")} SET ${sets.join(", ")}
		 WHERE id = $${idx++} AND ledger_id = $${idx}
		 RETURNING *`,
		queryParams,
	);

	const row = rows[0];
	if (!row) throw SummaError.notFound("Balance monitor not found");

	// Invalidate cache
	monitorCache.delete(row.account_id);

	return rawToMonitor(row);
}

export async function deleteMonitor(ctx: SummaContext, monitorId: string): Promise<void> {
	const t = createTableResolver(ctx.options.schema);
	const ledgerId = getLedgerId(ctx);

	// Get account_id for cache invalidation
	const existing = await ctx.adapter.raw<{ account_id: string }>(
		`SELECT account_id FROM ${t("balance_monitor")} WHERE id = $1 AND ledger_id = $2`,
		[monitorId, ledgerId],
	);

	const deleted = await ctx.adapter.rawMutate(
		`DELETE FROM ${t("balance_monitor")} WHERE id = $1 AND ledger_id = $2`,
		[monitorId, ledgerId],
	);

	if (deleted === 0) throw SummaError.notFound("Balance monitor not found");

	if (existing[0]) monitorCache.delete(existing[0].account_id);
}

// =============================================================================
// EVALUATION ENGINE
// =============================================================================

async function evaluateMonitorsForAccount(
	ctx: SummaContext,
	holderId: string,
	cacheTtlMs: number,
): Promise<void> {
	const t = createTableResolver(ctx.options.schema);
	const d = ctx.dialect;
	const ledgerId = getLedgerId(ctx);

	// Get account
	const accounts = await ctx.adapter.raw<{ id: string } & RawBalanceRow>(
		`SELECT id, balance, credit_balance, debit_balance, pending_credit, pending_debit
		 FROM ${t("account_balance")}
		 WHERE holder_id = $1 AND ledger_id = $2 LIMIT 1`,
		[holderId, ledgerId],
	);

	const account = accounts[0];
	if (!account) return;

	// Get monitors (with cache)
	let monitors = getCachedMonitors(account.id, cacheTtlMs);
	if (!monitors) {
		monitors = await ctx.adapter.raw<RawMonitorRow>(
			`SELECT * FROM ${t("balance_monitor")}
			 WHERE account_id = $1 AND active = true`,
			[account.id],
		);
		setCachedMonitors(account.id, monitors, cacheTtlMs);
	}

	if (monitors.length === 0) return;

	// Evaluate each monitor
	for (const monitor of monitors) {
		const fieldMap: Record<string, number> = {
			balance: Number(account.balance),
			credit_balance: Number(account.credit_balance),
			debit_balance: Number(account.debit_balance),
			pending_credit: Number(account.pending_credit),
			pending_debit: Number(account.pending_debit),
		};

		const currentValue = fieldMap[monitor.field];
		if (currentValue === undefined) continue;

		const triggered = checkCondition(
			currentValue,
			monitor.operator as MonitorOperator,
			Number(monitor.threshold),
		);

		if (triggered) {
			// Update last_triggered_at
			await ctx.adapter.rawMutate(
				`UPDATE ${t("balance_monitor")} SET last_triggered_at = ${d.now()} WHERE id = $1`,
				[monitor.id],
			);

			// Emit event to outbox for webhook delivery / external consumers
			try {
				await ctx.adapter.rawMutate(
					`INSERT INTO ${t("outbox")} (id, topic, payload, status, retry_count, created_at)
					 VALUES (${d.generateUuid()}, 'balance.monitor', $1, 'pending', 0, ${d.now()})`,
					[
						JSON.stringify({
							monitorId: monitor.id,
							accountId: account.id,
							holderId: monitor.holder_id,
							field: monitor.field,
							operator: monitor.operator,
							threshold: Number(monitor.threshold),
							currentValue,
							triggeredAt: new Date().toISOString(),
						}),
					],
				);
			} catch {
				// Outbox table may not exist if outbox plugin not loaded — silently skip
				ctx.logger.info("Balance monitor triggered (outbox unavailable)", {
					monitorId: monitor.id,
					holderId: monitor.holder_id,
					field: monitor.field,
					currentValue,
				});
			}
		}
	}
}

// =============================================================================
// PLUGIN FACTORY
// =============================================================================

export function balanceMonitor(options?: BalanceMonitorOptions): SummaPlugin {
	const cacheTtlMs = (options?.cacheTtlSeconds ?? 300) * 1000;

	return {
		id: "balance-monitor",

		$Infer: {} as { BalanceMonitorRecord: BalanceMonitorRecord },

		schema: monitorSchema,

		hooks: {
			afterTransaction: async (params) => {
				const holderId = params.holderId ?? params.sourceHolderId;
				if (!holderId) return;
				await evaluateMonitorsForAccount(params.ctx, holderId, cacheTtlMs);

				// Also check destination for transfers
				if (params.destinationHolderId) {
					await evaluateMonitorsForAccount(params.ctx, params.destinationHolderId, cacheTtlMs);
				}
			},
		},

		endpoints: [
			// POST /balance-monitors -- Create monitor
			{
				method: "POST",
				path: "/balance-monitors",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const body = req.body as Record<string, unknown> | null;
					if (!body || typeof body !== "object")
						return json(400, {
							error: { code: "INVALID_ARGUMENT", message: "Request body required" },
						});

					const holderId = body.holderId as string | undefined;
					const field = body.field as MonitorField | undefined;
					const operator = body.operator as MonitorOperator | undefined;
					const threshold = body.threshold as number | undefined;

					if (!holderId || !field || !operator || threshold === undefined)
						return json(400, {
							error: {
								code: "INVALID_ARGUMENT",
								message: "holderId, field, operator, and threshold are required",
							},
						});

					const validFields: MonitorField[] = [
						"balance",
						"credit_balance",
						"debit_balance",
						"pending_credit",
						"pending_debit",
					];
					if (!validFields.includes(field))
						return json(400, {
							error: {
								code: "INVALID_ARGUMENT",
								message: `field must be one of: ${validFields.join(", ")}`,
							},
						});

					const validOps: MonitorOperator[] = ["gt", "lt", "gte", "lte", "eq"];
					if (!validOps.includes(operator))
						return json(400, {
							error: {
								code: "INVALID_ARGUMENT",
								message: `operator must be one of: ${validOps.join(", ")}`,
							},
						});

					const result = await createMonitor(ctx, {
						holderId,
						field,
						operator,
						threshold,
						description: body.description as string | undefined,
					});
					return json(201, result);
				},
			},

			// GET /balance-monitors -- List monitors
			{
				method: "GET",
				path: "/balance-monitors",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const result = await listMonitors(ctx, {
						holderId: req.query.holderId,
						activeOnly: req.query.activeOnly !== "false",
					});
					return json(200, { monitors: result });
				},
			},

			// PUT /balance-monitors/:id -- Update monitor
			{
				method: "PUT",
				path: "/balance-monitors/:id",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const body = req.body as Record<string, unknown> | null;
					if (!body || typeof body !== "object")
						return json(400, {
							error: { code: "INVALID_ARGUMENT", message: "Request body required" },
						});

					const id = req.params.id ?? "";
					const result = await updateMonitor(ctx, id, body as Parameters<typeof updateMonitor>[2]);
					return json(200, result);
				},
			},

			// DELETE /balance-monitors/:id -- Delete monitor
			{
				method: "DELETE",
				path: "/balance-monitors/:id",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const id = req.params.id ?? "";
					await deleteMonitor(ctx, id);
					return json(200, { deleted: true });
				},
			},
		],
	};
}
