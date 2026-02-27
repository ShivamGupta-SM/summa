// =============================================================================
// VELOCITY LIMITS PLUGIN -- Transaction velocity controls as a Summa plugin
// =============================================================================
// Wraps the limit-manager enforcement logic into a composable plugin with
// lifecycle hooks. In v2 velocity queries run directly against the `entry`
// table, so no separate transaction log or cleanup worker is needed.

import type { SummaPlugin } from "@summa-ledger/core";

// =============================================================================
// OPTIONS
// =============================================================================

export interface VelocityLimitsOptions {
	/** Auto-enforce limits on transactions. Default: true */
	autoEnforce?: boolean;
}

// =============================================================================
// PLUGIN FACTORY
// =============================================================================

export function velocityLimits(options?: VelocityLimitsOptions): SummaPlugin {
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
	};
}
