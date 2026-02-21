// =============================================================================
// VELOCITY LIMITS PLUGIN -- Transaction velocity controls as a Summa plugin
// =============================================================================
// Wraps the limit-manager enforcement and cleanup logic into a composable
// plugin with lifecycle hooks and a background worker.

import type { SummaPlugin } from "@summa/core";

// =============================================================================
// OPTIONS
// =============================================================================

export interface VelocityLimitsOptions {
	/** Retention days for transaction logs. Default: 90 */
	cleanupRetentionDays?: number;
	/** Auto-enforce limits on transactions. Default: true */
	autoEnforce?: boolean;
}

// =============================================================================
// PLUGIN FACTORY
// =============================================================================

export function velocityLimits(options?: VelocityLimitsOptions): SummaPlugin {
	const retentionDays = options?.cleanupRetentionDays ?? 90;
	const autoEnforce = options?.autoEnforce ?? true;

	return {
		id: "velocity-limits",

		hooks: autoEnforce
			? {
					beforeTransaction: async (params) => {
						const { enforceLimits } = await import("../managers/limit-manager.js");

						// For credit/debit the holder is params.holderId.
						// For transfers the source account holder is params.sourceHolderId.
						const holderId = params.holderId ?? params.sourceHolderId;
						if (!holderId) return;

						// Map transaction types to velocity limit types
						const txnTypeMap: Record<string, "debit" | "credit"> = {
							credit: "credit",
							debit: "debit",
							transfer: "debit",
							correction: "debit",
							adjustment: "debit",
							journal: "debit",
						};
						const txnType = txnTypeMap[params.type] ?? "debit";

						await enforceLimits(params.ctx, {
							holderId,
							amount: params.amount,
							txnType,
							category: params.category,
						});
					},
				}
			: undefined,

		workers: [
			{
				id: "velocity-log-cleanup",
				description: "Remove old transaction log entries beyond retention period",
				handler: async (ctx) => {
					const { cleanupOldTransactionLogs } = await import("../managers/limit-manager.js");
					await cleanupOldTransactionLogs(ctx, retentionDays);
				},
				interval: "1d",
				leaseRequired: true,
			},
		],
	};
}
