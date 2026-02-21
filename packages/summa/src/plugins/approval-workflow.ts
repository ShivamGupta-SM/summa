// =============================================================================
// APPROVAL WORKFLOW PLUGIN -- Maker-Checker / Dual Authorization
// =============================================================================
// Enterprise dual authorization for large/sensitive transactions. Transactions
// matching approval rules are held pending until required approvals are met.
//
// Status is tracked via entity_status_log (append-only) instead of a mutable
// status column on approval_request.

import type {
	PluginApiRequest,
	PluginApiResponse,
	SummaContext,
	SummaOperation,
	SummaPlugin,
} from "@summa/core";
import { computeHash, SummaError } from "@summa/core";
import { createTableResolver } from "@summa/core/db";
import {
	getEntityStatus,
	initializeEntityStatus,
	transitionEntityStatus,
} from "../../infrastructure/entity-status.js";

// =============================================================================
// CONSTANTS
// =============================================================================

const ENTITY_TYPE = "approval_request";

// =============================================================================
// TYPES
// =============================================================================

export type ApprovalConditionType = "amount_gt" | "account_type" | "custom";

export interface ApprovalWorkflowOptions {
	/** Pre-seed rules on init. Default: [] */
	rules?: Array<{
		name: string;
		conditionType: ApprovalConditionType;
		conditionValue: Record<string, unknown>;
		requiredApprovals?: number;
		timeoutHours?: number;
	}>;
}

export interface ApprovalRule {
	id: string;
	name: string;
	conditionType: ApprovalConditionType;
	conditionValue: Record<string, unknown>;
	requiredApprovals: number;
	timeoutHours: number;
	enabled: boolean;
	createdAt: string;
}

export interface ApprovalRequest {
	id: string;
	transactionParams: Record<string, unknown>;
	operationType: string;
	ruleId: string;
	status: "pending" | "approved" | "consumed" | "rejected" | "expired";
	requestedBy: string | null;
	approvedBy: string[];
	rejectedBy: string | null;
	rejectedReason: string | null;
	expiresAt: string;
	createdAt: string;
	resolvedAt: string | null;
}

interface RawRuleRow {
	id: string;
	name: string;
	condition_type: string;
	condition_value: Record<string, unknown>;
	required_approvals: number;
	timeout_hours: number;
	enabled: boolean;
	created_at: string | Date;
}

/** Raw row from approval_request JOIN LATERAL entity_status_log */
interface RawRequestRow {
	id: string;
	transaction_params: Record<string, unknown>;
	operation_type: string;
	rule_id: string;
	/** status comes from entity_status_log via LATERAL JOIN */
	status: string;
	requested_by: string | null;
	approved_by: string[];
	expires_at: string | Date;
	created_at: string | Date;
	params_hash: string;
}

// =============================================================================
// HELPERS
// =============================================================================

function rawToRule(row: RawRuleRow): ApprovalRule {
	return {
		id: row.id,
		name: row.name,
		conditionType: row.condition_type as ApprovalConditionType,
		conditionValue: row.condition_value,
		requiredApprovals: row.required_approvals,
		timeoutHours: row.timeout_hours,
		enabled: row.enabled,
		createdAt:
			row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
	};
}

function rawToRequest(row: RawRequestRow): ApprovalRequest {
	return {
		id: row.id,
		transactionParams: row.transaction_params,
		operationType: row.operation_type,
		ruleId: row.rule_id,
		status: row.status as ApprovalRequest["status"],
		requestedBy: row.requested_by,
		approvedBy: Array.isArray(row.approved_by) ? row.approved_by : [],
		// rejected_by and rejected_reason now live in entity_status_log metadata;
		// they are not on the row itself — we leave them null here and enrich below
		// when needed (see getApprovalRequest).
		rejectedBy: null,
		rejectedReason: null,
		expiresAt:
			row.expires_at instanceof Date ? row.expires_at.toISOString() : String(row.expires_at),
		createdAt:
			row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
		resolvedAt: null,
	};
}

/**
 * Enrich an ApprovalRequest with rejection/resolution metadata from entity_status_log.
 * Only makes the extra query when the status warrants it.
 */
async function enrichFromStatusLog(
	ctx: SummaContext,
	req: ApprovalRequest,
): Promise<ApprovalRequest> {
	const entityStatus = await getEntityStatus(ctx.adapter, ENTITY_TYPE, req.id);
	if (!entityStatus) return req;

	const meta = entityStatus.metadata ?? {};

	if (req.status === "rejected") {
		req.rejectedBy = (meta.rejectedBy as string) ?? null;
		req.rejectedReason = (meta.rejectedReason as string) ?? null;
		req.resolvedAt = (meta.resolvedAt as string) ?? null;
	} else if (req.status === "approved" || req.status === "consumed" || req.status === "expired") {
		req.resolvedAt = (meta.resolvedAt as string) ?? null;
	}

	return req;
}

function jsonRes(status: number, body: unknown): PluginApiResponse {
	return { status, body };
}

function isTransactionOp(op: SummaOperation): boolean {
	return op.type.startsWith("transaction.");
}

/** Compute a stable hash of operation type + params for approval matching. */
function computeParamsHash(operationType: string, params: Record<string, unknown>): string {
	// Sort keys for deterministic JSON serialization
	const sorted = JSON.stringify(params, Object.keys(params).sort());
	return computeHash(null, { operationType, params: sorted });
}

/**
 * Build a SQL fragment that selects from approval_request with a LATERAL JOIN
 * to entity_status_log to get the current status.
 */
function requestWithStatusSql(t: (name: string) => string): string {
	return `SELECT ar.*, esl.status
FROM ${t("approval_request")} ar
JOIN LATERAL (
  SELECT status FROM ${t("entity_status_log")}
  WHERE entity_type = '${ENTITY_TYPE}' AND entity_id = ar.id::text
  ORDER BY created_at DESC LIMIT 1
) esl ON true`;
}

// =============================================================================
// CORE OPERATIONS
// =============================================================================

export async function listRules(ctx: SummaContext): Promise<ApprovalRule[]> {
	const t = createTableResolver(ctx.options.schema);
	const rows = await ctx.adapter.raw<RawRuleRow>(
		`SELECT * FROM ${t("approval_rule")} ORDER BY created_at DESC`,
		[],
	);
	return rows.map(rawToRule);
}

export async function createRule(
	ctx: SummaContext,
	params: {
		name: string;
		conditionType: ApprovalConditionType;
		conditionValue: Record<string, unknown>;
		requiredApprovals?: number;
		timeoutHours?: number;
	},
): Promise<ApprovalRule> {
	const t = createTableResolver(ctx.options.schema);
	const rows = await ctx.adapter.raw<RawRuleRow>(
		`INSERT INTO ${t("approval_rule")} (name, condition_type, condition_value, required_approvals, timeout_hours, enabled)
     VALUES ($1, $2, $3::jsonb, $4, $5, true)
     RETURNING *`,
		[
			params.name,
			params.conditionType,
			JSON.stringify(params.conditionValue),
			params.requiredApprovals ?? 1,
			params.timeoutHours ?? 24,
		],
	);
	const row = rows[0];
	if (!row) throw SummaError.internal("Failed to create approval rule");
	return rawToRule(row);
}

export async function listPendingRequests(ctx: SummaContext): Promise<ApprovalRequest[]> {
	const t = createTableResolver(ctx.options.schema);
	const rows = await ctx.adapter.raw<RawRequestRow>(
		`${requestWithStatusSql(t)}
WHERE esl.status = 'pending'
ORDER BY ar.created_at DESC`,
		[],
	);
	return rows.map(rawToRequest);
}

export async function getApprovalRequest(
	ctx: SummaContext,
	requestId: string,
): Promise<ApprovalRequest> {
	const t = createTableResolver(ctx.options.schema);
	const rows = await ctx.adapter.raw<RawRequestRow>(
		`${requestWithStatusSql(t)}
WHERE ar.id = $1`,
		[requestId],
	);
	const row = rows[0];
	if (!row) throw SummaError.notFound("Approval request not found");
	return enrichFromStatusLog(ctx, rawToRequest(row));
}

export async function approveRequest(
	ctx: SummaContext,
	params: { requestId: string; approvedBy: string },
): Promise<ApprovalRequest> {
	const t = createTableResolver(ctx.options.schema);

	// Fetch current request (includes status from entity_status_log)
	const current = await getApprovalRequest(ctx, params.requestId);
	if (current.status !== "pending") {
		throw SummaError.conflict(`Approval request is already ${current.status}`);
	}

	// Add approver
	const updatedApprovers = [...current.approvedBy, params.approvedBy];

	// Load the rule to check required approvals
	const ruleRows = await ctx.adapter.raw<RawRuleRow>(
		`SELECT * FROM ${t("approval_rule")} WHERE id = $1`,
		[current.ruleId],
	);
	const rule = ruleRows[0];
	const requiredApprovals = rule?.required_approvals ?? 1;

	const isFullyApproved = updatedApprovers.length >= requiredApprovals;

	// Update approved_by on the approval_request row (still mutable — it's not status)
	await ctx.adapter.raw(
		`UPDATE ${t("approval_request")}
     SET approved_by = $1::jsonb
     WHERE id = $2`,
		[JSON.stringify(updatedApprovers), params.requestId],
	);

	// Transition status if fully approved
	if (isFullyApproved) {
		const resolvedAt = new Date().toISOString();
		await transitionEntityStatus({
			tx: ctx.adapter,
			entityType: ENTITY_TYPE,
			entityId: params.requestId,
			status: "approved",
			expectedCurrentStatus: "pending",
			reason: `Fully approved by ${updatedApprovers.join(", ")}`,
			metadata: { resolvedAt },
		});
	}

	return getApprovalRequest(ctx, params.requestId);
}

export async function rejectRequest(
	ctx: SummaContext,
	params: { requestId: string; rejectedBy: string; reason?: string },
): Promise<ApprovalRequest> {
	const current = await getApprovalRequest(ctx, params.requestId);
	if (current.status !== "pending") {
		throw SummaError.conflict(`Approval request is already ${current.status}`);
	}

	const resolvedAt = new Date().toISOString();
	await transitionEntityStatus({
		tx: ctx.adapter,
		entityType: ENTITY_TYPE,
		entityId: params.requestId,
		status: "rejected",
		expectedCurrentStatus: "pending",
		reason: params.reason ?? `Rejected by ${params.rejectedBy}`,
		metadata: {
			rejectedBy: params.rejectedBy,
			rejectedReason: params.reason ?? null,
			resolvedAt,
		},
	});

	return getApprovalRequest(ctx, params.requestId);
}

// =============================================================================
// RULE MATCHING
// =============================================================================

function matchesRule(rule: ApprovalRule, op: SummaOperation): boolean {
	if (!rule.enabled) return false;

	// Cast to Record for dynamic property access across union variants
	const params = op.params as Record<string, unknown>;
	switch (rule.conditionType) {
		case "amount_gt": {
			const threshold = Number(rule.conditionValue.amount ?? 0);
			const amount = Number(params.amount ?? 0);
			return amount > threshold;
		}
		case "account_type": {
			const targetType = String(rule.conditionValue.accountType ?? "");
			const holderType = String(params.holderType ?? "");
			return holderType === targetType;
		}
		case "custom":
			// Custom rules always match — the rule creator controls via the condition_value metadata
			return true;
		default:
			return false;
	}
}

// =============================================================================
// PLUGIN FACTORY
// =============================================================================

export function approvalWorkflow(options?: ApprovalWorkflowOptions): SummaPlugin {
	return {
		id: "approval-workflow",

		schema: {
			approval_rule: {
				columns: {
					id: { type: "uuid", primaryKey: true },
					name: { type: "text", notNull: true },
					condition_type: { type: "text", notNull: true },
					condition_value: { type: "jsonb", notNull: true },
					required_approvals: { type: "integer", default: "1" },
					timeout_hours: { type: "integer", default: "24" },
					enabled: { type: "boolean", default: "true" },
					created_at: { type: "timestamp", default: "NOW()" },
				},
			},
			approval_request: {
				columns: {
					id: { type: "uuid", primaryKey: true },
					transaction_params: { type: "jsonb", notNull: true },
					operation_type: { type: "text", notNull: true },
					rule_id: {
						type: "uuid",
						notNull: true,
						references: { table: "approval_rule", column: "id" },
					},
					requested_by: { type: "text" },
					approved_by: { type: "jsonb", default: "'[]'" },
					expires_at: { type: "timestamp", notNull: true },
					created_at: { type: "timestamp", default: "NOW()" },
					params_hash: { type: "text", notNull: true },
				},
				indexes: [
					{ name: "idx_approval_request_rule", columns: ["rule_id"] },
					{ name: "idx_approval_request_hash", columns: ["params_hash"] },
				],
			},
		},

		init: async (ctx) => {
			const t = createTableResolver(ctx.options.schema);
			// Seed rules from options
			if (options?.rules?.length) {
				for (const rule of options.rules) {
					await ctx.adapter.raw(
						`INSERT INTO ${t("approval_rule")} (name, condition_type, condition_value, required_approvals, timeout_hours, enabled)
             VALUES ($1, $2, $3::jsonb, $4, $5, true)
             ON CONFLICT DO NOTHING`,
						[
							rule.name,
							rule.conditionType,
							JSON.stringify(rule.conditionValue),
							rule.requiredApprovals ?? 1,
							rule.timeoutHours ?? 24,
						],
					);
				}
			}
		},

		operationHooks: {
			before: [
				{
					matcher: isTransactionOp,
					handler: async (hookCtx) => {
						const t = createTableResolver(hookCtx.context.options.schema);
						const rules = await listRules(hookCtx.context);
						for (const rule of rules) {
							if (matchesRule(rule, hookCtx.operation)) {
								// Check if there's an existing approved request via stable hash
								// using LATERAL JOIN to entity_status_log
								const paramsHash = computeParamsHash(
									hookCtx.operation.type,
									hookCtx.operation.params as Record<string, unknown>,
								);
								const existing = await hookCtx.context.adapter.raw<RawRequestRow>(
									`${requestWithStatusSql(t)}
WHERE ar.params_hash = $1
  AND esl.status = 'approved'
LIMIT 1`,
									[paramsHash],
								);

								if (existing[0]) {
									// Mark the approval as consumed to prevent replay
									await transitionEntityStatus({
										tx: hookCtx.context.adapter,
										entityType: ENTITY_TYPE,
										entityId: existing[0].id,
										status: "consumed",
										expectedCurrentStatus: "approved",
										reason: "Consumed by transaction execution",
									});
									return undefined;
								}

								// Create a pending approval request
								const expiresAt = new Date(Date.now() + rule.timeoutHours * 60 * 60 * 1000);
								const rows = await hookCtx.context.adapter.raw<{ id: string }>(
									`INSERT INTO ${t("approval_request")}
                   (transaction_params, operation_type, rule_id, expires_at, params_hash)
                   VALUES ($1::jsonb, $2, $3, $4, $5)
                   RETURNING id`,
									[
										JSON.stringify(hookCtx.operation.params),
										hookCtx.operation.type,
										rule.id,
										expiresAt.toISOString(),
										paramsHash,
									],
								);

								const approvalId = rows[0]?.id ?? "unknown";

								// Initialize status in entity_status_log
								await initializeEntityStatus(
									hookCtx.context.adapter,
									ENTITY_TYPE,
									approvalId,
									"pending",
								);

								return {
									cancel: true as const,
									reason: `Approval required (rule: ${rule.name}, approvalId: ${approvalId})`,
								};
							}
						}
						return undefined;
					},
				},
			],
		},

		workers: [
			{
				id: "approval-expiry",
				description: "Expire timed-out approval requests",
				interval: "5m",
				leaseRequired: false,
				handler: async (ctx) => {
					const t = createTableResolver(ctx.options.schema);
					// Find pending requests that have expired using LATERAL JOIN
					const expired = await ctx.adapter.raw<{ id: string }>(
						`${requestWithStatusSql(t)}
WHERE esl.status = 'pending'
  AND ar.expires_at < NOW()`,
						[],
					);
					for (const row of expired) {
						await transitionEntityStatus({
							tx: ctx.adapter,
							entityType: ENTITY_TYPE,
							entityId: row.id,
							status: "expired",
							expectedCurrentStatus: "pending",
							reason: "Timed out",
							metadata: { resolvedAt: new Date().toISOString() },
						});
					}
				},
			},
		],

		endpoints: [
			{
				method: "GET",
				path: "/approvals",
				handler: async (_req: PluginApiRequest, ctx: SummaContext) => {
					const requests = await listPendingRequests(ctx);
					return jsonRes(200, requests);
				},
			},
			{
				method: "GET",
				path: "/approvals/:id",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const request = await getApprovalRequest(ctx, req.params.id ?? "");
					return jsonRes(200, request);
				},
			},
			{
				method: "POST",
				path: "/approvals/:id/approve",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const body = req.body as { approvedBy: string };
					if (!body.approvedBy) {
						return jsonRes(400, {
							error: { code: "INVALID_ARGUMENT", message: "approvedBy required" },
						});
					}
					const result = await approveRequest(ctx, {
						requestId: req.params.id ?? "",
						approvedBy: body.approvedBy,
					});
					return jsonRes(200, result);
				},
			},
			{
				method: "POST",
				path: "/approvals/:id/reject",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const body = req.body as { rejectedBy: string; reason?: string };
					if (!body.rejectedBy) {
						return jsonRes(400, {
							error: { code: "INVALID_ARGUMENT", message: "rejectedBy required" },
						});
					}
					const result = await rejectRequest(ctx, {
						requestId: req.params.id ?? "",
						...body,
					});
					return jsonRes(200, result);
				},
			},
			{
				method: "GET",
				path: "/approval-rules",
				handler: async (_req: PluginApiRequest, ctx: SummaContext) => {
					const rules = await listRules(ctx);
					return jsonRes(200, rules);
				},
			},
			{
				method: "POST",
				path: "/approval-rules",
				handler: async (req: PluginApiRequest, ctx: SummaContext) => {
					const body = req.body as {
						name: string;
						conditionType: ApprovalConditionType;
						conditionValue: Record<string, unknown>;
						requiredApprovals?: number;
						timeoutHours?: number;
					};
					if (!body.name || !body.conditionType || !body.conditionValue) {
						return jsonRes(400, {
							error: {
								code: "INVALID_ARGUMENT",
								message: "name, conditionType, conditionValue required",
							},
						});
					}
					const rule = await createRule(ctx, body);
					return jsonRes(201, rule);
				},
			},
		],
	};
}
