// =============================================================================
// ENTITY STATUS — Shared append-only status tracking for all plugins
// =============================================================================
// Instead of UPDATE-ing status columns on plugin tables, all status transitions
// are recorded as new rows in entity_status_log. The current status is always
// the latest row for a given (entity_type, entity_id).

import { randomUUID } from "node:crypto";
import type { SummaTransactionAdapter } from "@summa/core";
import { SummaError } from "@summa/core";
import { createTableResolver } from "@summa/core/db";

// =============================================================================
// TYPES
// =============================================================================

export interface EntityStatus {
	status: string;
	previousStatus: string | null;
	reason: string | null;
	metadata: Record<string, unknown> | null;
	createdAt: Date;
}

export interface TransitionParams {
	/** The DB transaction handle */
	tx: SummaTransactionAdapter;
	/** Entity type identifier (e.g., 'approval_request', 'import_batch') */
	entityType: string;
	/** Entity UUID */
	entityId: string;
	/** New status */
	status: string;
	/** Optional reason for the transition */
	reason?: string;
	/** Optional metadata for this transition */
	metadata?: Record<string, unknown>;
	/** If provided, will validate that the current status matches before transitioning */
	expectedCurrentStatus?: string | string[];
}

// =============================================================================
// GET CURRENT STATUS
// =============================================================================

/**
 * Get the current status of an entity by reading the latest entity_status_log row.
 * Returns null if no status has been recorded yet.
 */
export async function getEntityStatus(
	tx: SummaTransactionAdapter,
	entityType: string,
	entityId: string,
): Promise<EntityStatus | null> {
	const t = createTableResolver(tx.options?.schema ?? "summa");
	const rows = await tx.raw<{
		status: string;
		previous_status: string | null;
		reason: string | null;
		metadata: Record<string, unknown> | null;
		created_at: string | Date;
	}>(
		`SELECT status, previous_status, reason, metadata, created_at
     FROM ${t("entity_status_log")}
     WHERE entity_type = $1 AND entity_id = $2
     ORDER BY created_at DESC
     LIMIT 1`,
		[entityType, entityId],
	);

	const row = rows[0];
	if (!row) return null;

	return {
		status: row.status,
		previousStatus: row.previous_status,
		reason: row.reason,
		metadata: row.metadata,
		createdAt: new Date(row.created_at),
	};
}

// =============================================================================
// TRANSITION STATUS
// =============================================================================

/**
 * Record a status transition by inserting a new row into entity_status_log.
 *
 * If `expectedCurrentStatus` is provided, validates that the entity is
 * currently in one of the expected statuses before transitioning. This prevents
 * invalid state machine transitions.
 *
 * Returns the new EntityStatus record.
 */
export async function transitionEntityStatus(params: TransitionParams): Promise<EntityStatus> {
	const { tx, entityType, entityId, status, reason, metadata } = params;
	const t = createTableResolver(tx.options?.schema ?? "summa");

	// Get current status for validation and previousStatus tracking
	const current = await getEntityStatus(tx, entityType, entityId);
	const previousStatus = current?.status ?? null;

	// Validate expected current status if provided
	if (params.expectedCurrentStatus != null) {
		const expected = Array.isArray(params.expectedCurrentStatus)
			? params.expectedCurrentStatus
			: [params.expectedCurrentStatus];

		if (previousStatus === null) {
			throw SummaError.conflict(
				`Entity ${entityType}:${entityId} has no status yet, expected one of: ${expected.join(", ")}`,
			);
		}

		if (!expected.includes(previousStatus)) {
			throw SummaError.conflict(
				`Entity ${entityType}:${entityId} is in status "${previousStatus}", expected one of: ${expected.join(", ")}`,
			);
		}
	}

	// Insert new status row
	const id = randomUUID();
	await tx.raw(
		`INSERT INTO ${t("entity_status_log")} (id, entity_type, entity_id, status, previous_status, reason, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
		[
			id,
			entityType,
			entityId,
			status,
			previousStatus,
			reason ?? null,
			metadata ? JSON.stringify(metadata) : null,
		],
	);

	return {
		status,
		previousStatus,
		reason: reason ?? null,
		metadata: metadata ?? null,
		createdAt: new Date(),
	};
}

// =============================================================================
// INITIALIZE STATUS
// =============================================================================

/**
 * Record the initial status for a newly created entity.
 * Shorthand for transitionEntityStatus with no expectedCurrentStatus check.
 */
export async function initializeEntityStatus(
	tx: SummaTransactionAdapter,
	entityType: string,
	entityId: string,
	status: string,
	metadata?: Record<string, unknown>,
): Promise<EntityStatus> {
	return transitionEntityStatus({
		tx,
		entityType,
		entityId,
		status,
		metadata,
	});
}

// =============================================================================
// GET STATUS HISTORY
// =============================================================================

/**
 * Get the full status history for an entity, ordered newest first.
 */
export async function getEntityStatusHistory(
	tx: SummaTransactionAdapter,
	entityType: string,
	entityId: string,
): Promise<EntityStatus[]> {
	const t = createTableResolver(tx.options?.schema ?? "summa");
	const rows = await tx.raw<{
		status: string;
		previous_status: string | null;
		reason: string | null;
		metadata: Record<string, unknown> | null;
		created_at: string | Date;
	}>(
		`SELECT status, previous_status, reason, metadata, created_at
     FROM ${t("entity_status_log")}
     WHERE entity_type = $1 AND entity_id = $2
     ORDER BY created_at DESC`,
		[entityType, entityId],
	);

	return rows.map((row) => ({
		status: row.status,
		previousStatus: row.previous_status,
		reason: row.reason,
		metadata: row.metadata,
		createdAt: new Date(row.created_at),
	}));
}
