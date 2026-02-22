// =============================================================================
// AUDIT LOG PLUGIN
// =============================================================================
// Immutable audit trail for all ledger operations.
// Records operation type, actor, parameters, and result with timestamps.

import type {
	SummaContext,
	SummaOperation,
	SummaPlugin,
	TableDefinition,
} from "@summa-ledger/core";
import { computeHash } from "@summa-ledger/core";
import { createTableResolver } from "@summa-ledger/core/db";

// =============================================================================
// TYPES
// =============================================================================

export interface AuditLogOptions {
	/** Which operation types to audit. Default: all operations */
	operations?: SummaOperation["type"][];
	/** Retention days. Default: 365 */
	retentionDays?: number;
	/** Cleanup interval. Default: "1d" */
	cleanupInterval?: string;
}

export interface AuditLogEntry {
	id: string;
	operation: string;
	params: Record<string, unknown>;
	actor: string | null;
	entryHash: string | null;
	timestamp: string;
}

// =============================================================================
// SCHEMA
// =============================================================================

const auditLogSchema: Record<string, TableDefinition> = {
	audit_log: {
		columns: {
			id: { type: "uuid", primaryKey: true, notNull: true },
			operation: { type: "text", notNull: true },
			params: { type: "jsonb", notNull: true },
			actor: { type: "text" },
			result: { type: "jsonb" },
			entry_hash: { type: "text" },
			created_at: { type: "timestamp", notNull: true, default: "NOW()" },
		},
		indexes: [
			{ name: "idx_audit_log_operation", columns: ["operation"] },
			{ name: "idx_audit_log_actor", columns: ["actor"] },
			{ name: "idx_audit_log_created_at", columns: ["created_at"] },
		],
	},
};

// =============================================================================
// PLUGIN FACTORY
// =============================================================================

export function auditLog(options?: AuditLogOptions): SummaPlugin {
	const retentionDays = options?.retentionDays ?? 365;
	const allowedOps = options?.operations ? new Set(options.operations) : null;

	function shouldAudit(opType: string): boolean {
		if (!allowedOps) return true;
		return allowedOps.has(opType as SummaOperation["type"]);
	}

	return {
		id: "audit-log",

		$Infer: {} as { AuditLogEntry: AuditLogEntry },

		schema: auditLogSchema,

		operationHooks: {
			after: [
				{
					matcher: (op) => shouldAudit(op.type),
					handler: async ({ operation, context, requestContext }) => {
						const d = context.dialect;
						const t = createTableResolver(context.options.schema);
						const actor = requestContext?.actor ?? null;
						const entryHash = computeHash(
							null,
							{
								operation: operation.type,
								params: operation.params,
								actor,
							},
							context.options.advanced.hmacSecret,
						);
						await context.adapter.rawMutate(
							`INSERT INTO ${t("audit_log")} (id, operation, params, actor, entry_hash, created_at)
							 VALUES (${d.generateUuid()}, $1, $2, $3, $4, ${d.now()})`,
							[operation.type, JSON.stringify(operation.params), actor, entryHash],
						);
					},
				},
			],
		},

		workers: [
			{
				id: "audit-log-cleanup",
				description: `Remove audit log entries older than ${retentionDays} days`,
				handler: async (ctx: SummaContext) => {
					const t = createTableResolver(ctx.options.schema);
					const deleted = await ctx.adapter.rawMutate(
						`DELETE FROM ${t("audit_log")}
						 WHERE created_at < ${ctx.dialect.now()} - ${ctx.dialect.interval("1 day")} * $1`,
						[retentionDays],
					);
					if (deleted > 0) {
						ctx.logger.info("Cleaned up old audit log entries", {
							count: deleted,
							retentionDays,
						});
					}
				},
				interval: options?.cleanupInterval ?? "1d",
				leaseRequired: true,
			},
		],
	};
}

// =============================================================================
// QUERY FUNCTIONS
// =============================================================================

/** Query audit log entries with filters */
export async function queryAuditLog(
	ctx: SummaContext,
	params?: {
		operation?: string;
		actor?: string;
		since?: Date;
		until?: Date;
		limit?: number;
		offset?: number;
	},
): Promise<AuditLogEntry[]> {
	const t = createTableResolver(ctx.options.schema);
	const conditions: string[] = [];
	const queryParams: unknown[] = [];
	let paramIndex = 1;

	if (params?.operation) {
		conditions.push(`operation = $${paramIndex++}`);
		queryParams.push(params.operation);
	}
	if (params?.actor) {
		conditions.push(`actor = $${paramIndex++}`);
		queryParams.push(params.actor);
	}
	if (params?.since) {
		conditions.push(`created_at >= $${paramIndex++}`);
		queryParams.push(params.since.toISOString());
	}
	if (params?.until) {
		conditions.push(`created_at <= $${paramIndex++}`);
		queryParams.push(params.until.toISOString());
	}

	const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
	const limit = params?.limit ?? 50;
	const offset = params?.offset ?? 0;

	queryParams.push(limit, offset);

	const entries = await ctx.adapter.raw<AuditLogEntry>(
		`SELECT id, operation, params, actor, entry_hash as "entryHash", created_at as timestamp
		 FROM ${t("audit_log")}
		 ${whereClause}
		 ORDER BY created_at DESC
		 LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
		queryParams,
	);

	// Verify integrity of each entry (log warnings, don't throw — audit reads shouldn't crash)
	for (const entry of entries) {
		if (entry.entryHash) {
			const entryParams =
				typeof entry.params === "string" ? JSON.parse(entry.params) : entry.params;
			const expected = computeHash(
				null,
				{
					operation: entry.operation,
					params: entryParams,
					actor: entry.actor,
				},
				ctx.options.advanced.hmacSecret,
			);
			if (expected !== entry.entryHash) {
				ctx.logger.error("Audit log entry integrity violation — hash mismatch", {
					entryId: entry.id,
					operation: entry.operation,
				});
			}
		}
	}

	return entries;
}
