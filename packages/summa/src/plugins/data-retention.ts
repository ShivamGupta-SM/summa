// =============================================================================
// DATA RETENTION PLUGIN -- Cleanup policy for plugin-owned tables
// =============================================================================
// Manages retention for velocity logs, audit logs, hot account entries,
// and FX quotes. Core-owned tables (idempotency_key, processed_event,
// worker_lease) are now cleaned by core workers and the outbox plugin.

import type { PluginApiRequest, PluginApiResponse, SummaContext, SummaPlugin } from "@summa/core";
import { createTableResolver } from "@summa/core/db";

// =============================================================================
// TYPES
// =============================================================================

export interface DataRetentionOptions {
	/** Retention for audit logs. e.g. "365d", "7y". */
	auditLogs?: string;
	/** Retention for hot account entries. e.g. "24h" */
	hotAccountEntries?: string;
	/** Retention for velocity/rate-limit logs. Default: "30d" */
	velocityLogs?: string;
	/** Retention for FX quotes. e.g. "30d" */
	fxQuotes?: string;
	/** Retention for ledger events (metadata cleanup, not deletion). Default: never */
	events?: string;
	/** How often the cleanup worker runs. Default: "6h" */
	interval?: string;
}

interface RetentionPolicy {
	table: string;
	column: string;
	retention: string;
	description: string;
}

// =============================================================================
// HELPERS
// =============================================================================

/** Parse a retention string like "24h", "7d", "365d", "7y" into a PostgreSQL interval string. */
function parseRetention(value: string): string {
	const match = value.match(/^(\d+)(h|d|m|y)$/);
	if (!match) throw new Error(`Invalid retention format: "${value}". Use e.g. "24h", "7d", "1y"`);
	const num = match[1];
	const unit = match[2];
	switch (unit) {
		case "h":
			return `${num} hours`;
		case "d":
			return `${num} days`;
		case "m":
			return `${num} months`;
		case "y":
			return `${num} years`;
		default:
			return `${num} days`;
	}
}

function jsonRes(status: number, body: unknown): PluginApiResponse {
	return { status, body };
}

// =============================================================================
// PLUGIN FACTORY
// =============================================================================

export function dataRetention(options?: DataRetentionOptions): SummaPlugin {
	const opts = options ?? {};
	const interval = opts.interval ?? "6h";

	// Build retention policies from options
	function buildPolicies(): RetentionPolicy[] {
		const policies: RetentionPolicy[] = [];

		// Rate limit logs — always included (no other owner)
		policies.push({
			table: "rate_limit_log",
			column: "created_at",
			retention: opts.velocityLogs ?? "30d",
			description: "Velocity/rate-limit logs",
		});

		// Optional policies (only if the related plugin tables exist)
		if (opts.auditLogs) {
			policies.push({
				table: "audit_log",
				column: "created_at",
				retention: opts.auditLogs,
				description: "Audit log entries",
			});
		}

		if (opts.hotAccountEntries) {
			policies.push({
				table: "hot_account_entry",
				column: "created_at",
				retention: opts.hotAccountEntries,
				description: "Hot account entries",
			});
		}

		if (opts.fxQuotes) {
			policies.push({
				table: "fx_rate_quote",
				column: "created_at",
				retention: opts.fxQuotes,
				description: "FX rate quotes",
			});
		}

		return policies;
	}

	return {
		id: "data-retention",

		workers: [
			{
				id: "data-retention-cleanup",
				description: "Unified data retention cleanup",
				interval,
				leaseRequired: true,
				handler: async (ctx: SummaContext) => {
					const t = createTableResolver(ctx.options.schema);
					const policies = buildPolicies();

					for (const policy of policies) {
						try {
							const pgInterval = parseRetention(policy.retention);
							const deleted = await ctx.adapter.rawMutate(
								`DELETE FROM ${t(policy.table)} WHERE ${policy.column} < NOW() - INTERVAL '${pgInterval}'`,
								[],
							);
							if (deleted > 0) {
								ctx.logger.info(`Data retention: cleaned ${policy.description}`, {
									table: policy.table,
									deleted,
									retention: policy.retention,
								});
							}
						} catch (err) {
							// Table may not exist if plugin is not registered — skip silently
							ctx.logger.debug(`Data retention: skipped ${policy.table}`, {
								error: String(err),
							});
						}
					}
				},
			},
		],

		endpoints: [
			{
				method: "GET",
				path: "/retention/status",
				handler: async (_req: PluginApiRequest, ctx: SummaContext) => {
					const t = createTableResolver(ctx.options.schema);
					const policies = buildPolicies();
					const status: Record<string, unknown> = {};

					for (const policy of policies) {
						try {
							const rows = await ctx.adapter.raw<{ cnt: string }>(
								`SELECT COUNT(*) as cnt FROM ${t(policy.table)}`,
								[],
							);
							status[policy.table] = {
								rowCount: Number(rows[0]?.cnt ?? 0),
								retention: policy.retention,
								cleanupColumn: policy.column,
								description: policy.description,
							};
						} catch {
							status[policy.table] = {
								status: "table_not_found",
								retention: policy.retention,
							};
						}
					}

					return jsonRes(200, { policies: status, interval });
				},
			},
		],
	};
}
