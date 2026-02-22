// =============================================================================
// API VALIDATION — Shared validation helpers and schemas for route handlers
// =============================================================================

import type { PluginApiResponse } from "@summa/core";

// =============================================================================
// FIELD SPEC VALIDATION
// =============================================================================

export type FieldSpec =
	| "string"
	| "number"
	| "boolean"
	| "object"
	| "string?"
	| "number?"
	| "boolean?"
	| "object?";

export function validateBody(
	body: unknown,
	fields: Record<string, FieldSpec>,
): { error: string } | null {
	if (body === null || body === undefined || typeof body !== "object") {
		return { error: "Request body must be a JSON object" };
	}
	const obj = body as Record<string, unknown>;
	for (const [key, spec] of Object.entries(fields)) {
		const optional = spec.endsWith("?");
		const expectedType = optional ? spec.slice(0, -1) : spec;
		const value = obj[key];
		if (value === undefined || value === null) {
			if (!optional) return { error: `Missing required field: "${key}"` };
			continue;
		}
		if (expectedType === "array") {
			if (!Array.isArray(value)) {
				return { error: `Field "${key}" must be an array, got ${typeof value}` };
			}
		} else if (typeof value !== expectedType) {
			return { error: `Field "${key}" must be ${expectedType}, got ${typeof value}` };
		}
	}
	return null;
}

export function validatePositiveIntegerAmount(body: unknown): { error: string } | null {
	const obj = body as Record<string, unknown>;
	const amount = obj.amount;
	if (typeof amount === "number") {
		if (!Number.isFinite(amount) || amount <= 0 || !Number.isInteger(amount)) {
			return { error: "amount must be a positive integer (in smallest currency units)" };
		}
	}
	return null;
}

// =============================================================================
// ENUM VALIDATION
// =============================================================================

export const VALID_ACCOUNT_STATUSES: ReadonlySet<string> = new Set(["active", "frozen", "closed"]);
export const VALID_HOLDER_TYPES: ReadonlySet<string> = new Set([
	"individual",
	"organization",
	"system",
]);
export const VALID_TX_STATUSES: ReadonlySet<string> = new Set([
	"pending",
	"inflight",
	"posted",
	"expired",
	"voided",
	"reversed",
]);
export const VALID_TX_TYPES: ReadonlySet<string> = new Set([
	"credit",
	"debit",
	"transfer",
	"journal",
	"correction",
	"adjustment",
]);
export const VALID_HOLD_STATUSES: ReadonlySet<string> = new Set([
	"inflight",
	"posted",
	"voided",
	"expired",
]);
export const VALID_TXN_TYPES: ReadonlySet<string> = new Set(["credit", "debit", "hold"]);
export const VALID_LIMIT_TYPES: ReadonlySet<string> = new Set([
	"per_transaction",
	"daily",
	"monthly",
]);
export const VALID_ADJUSTMENT_TYPES: ReadonlySet<string> = new Set([
	"accrual",
	"depreciation",
	"correction",
	"reclassification",
]);

export function validateEnum(
	value: string | undefined,
	validSet: ReadonlySet<string>,
	label: string,
): PluginApiResponse | null {
	if (value && !validSet.has(value)) {
		return {
			status: 400,
			body: {
				error: {
					code: "INVALID_ARGUMENT",
					message: `Invalid ${label}: "${value}". Must be one of: ${[...validSet].join(", ")}`,
				},
			},
			headers: { "Content-Type": "application/json" },
		};
	}
	return null;
}

// =============================================================================
// SHARED VALIDATION SCHEMAS — Deduplicated field specs for transaction routes
// =============================================================================

const TX_BASE_FIELDS = {
	amount: "number" as const,
	reference: "string" as const,
	description: "string?" as const,
	category: "string?" as const,
	idempotencyKey: "string?" as const,
};

export const VALIDATION_SCHEMAS = {
	credit: {
		holderId: "string" as const,
		...TX_BASE_FIELDS,
		sourceSystemAccount: "string?" as const,
	},
	debit: {
		holderId: "string" as const,
		...TX_BASE_FIELDS,
		destinationSystemAccount: "string?" as const,
		allowOverdraft: "boolean?" as const,
	},
	transfer: {
		sourceHolderId: "string" as const,
		destinationHolderId: "string" as const,
		...TX_BASE_FIELDS,
		exchangeRate: "number?" as const,
	},
	multiTransfer: {
		sourceHolderId: "string" as const,
		...TX_BASE_FIELDS,
		destinations: "object" as const,
	},
	refund: {
		transactionId: "string" as const,
		reason: "string" as const,
		amount: "number?" as const,
		idempotencyKey: "string?" as const,
	},
	correct: {
		transactionId: "string" as const,
		correctionEntries: "object" as const,
		reason: "string" as const,
	},
	adjust: {
		entries: "object" as const,
		reference: "string" as const,
		adjustmentType: "string" as const,
	},
	journal: {
		entries: "object" as const,
		reference: "string" as const,
	},
	hold: {
		holderId: "string" as const,
		amount: "number" as const,
		reference: "string" as const,
		description: "string?" as const,
		category: "string?" as const,
		destinationHolderId: "string?" as const,
		destinationSystemAccount: "string?" as const,
		expiresInMinutes: "number?" as const,
		idempotencyKey: "string?" as const,
	},
	holdMultiDest: {
		holderId: "string" as const,
		amount: "number" as const,
		reference: "string" as const,
		description: "string?" as const,
		category: "string?" as const,
		destinations: "object" as const,
		expiresInMinutes: "number?" as const,
		idempotencyKey: "string?" as const,
	},
} as const;
