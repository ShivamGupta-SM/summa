// =============================================================================
// MAINTENANCE PLUGIN -- Periodic cleanup tasks
// =============================================================================
// Bundles housekeeping workers that were individual cron jobs in the original
// Encore ledger: idempotency key cleanup, expired worker lease cleanup,
// and processed event cleanup.

import type { SummaPlugin } from "@summa/core";

// =============================================================================
// OPTIONS
// =============================================================================

export interface MaintenanceOptions {
	/** Idempotency key cleanup interval. Default: "1h" */
	idempotencyCleanupInterval?: string;
	/** Worker lease cleanup interval. Default: "6h" */
	leaseCleanupInterval?: string;
	/** Processed event retention hours. Default: 168 (7 days) */
	processedEventRetentionHours?: number;
	/** Processed event cleanup interval. Default: "1d" */
	processedEventCleanupInterval?: string;
}

// =============================================================================
// PLUGIN FACTORY
// =============================================================================

export function maintenance(options?: MaintenanceOptions): SummaPlugin {
	const processedEventRetentionHours = options?.processedEventRetentionHours ?? 168;

	return {
		id: "maintenance",

		workers: [
			{
				id: "idempotency-cleanup",
				description: "Remove expired idempotency keys",
				handler: async (ctx) => {
					const { cleanupExpiredKeys } = await import("../managers/idempotency.js");
					await cleanupExpiredKeys(ctx);
				},
				interval: options?.idempotencyCleanupInterval ?? "1h",
				leaseRequired: true,
			},
			{
				id: "worker-lease-cleanup",
				description: "Remove expired worker leases from dead instances",
				handler: async (ctx) => {
					const deleted = await ctx.adapter.rawMutate(
						`DELETE FROM worker_lease WHERE lease_until < NOW() - INTERVAL '1 hour'`,
						[],
					);
					if (deleted > 0) {
						ctx.logger.info("Cleaned up expired worker leases", { count: deleted });
					}
				},
				interval: options?.leaseCleanupInterval ?? "6h",
				leaseRequired: true,
			},
			{
				id: "processed-event-cleanup",
				description: "Remove old processed event records beyond retention period",
				handler: async (ctx) => {
					const deleted = await ctx.adapter.rawMutate(
						`DELETE FROM processed_event
						 WHERE processed_at < NOW() - INTERVAL '1 hour' * $1`,
						[processedEventRetentionHours],
					);
					if (deleted > 0) {
						ctx.logger.info("Cleaned up old processed events", {
							count: deleted,
							retentionHours: processedEventRetentionHours,
						});
					}
				},
				interval: options?.processedEventCleanupInterval ?? "1d",
				leaseRequired: true,
			},
		],
	};
}
