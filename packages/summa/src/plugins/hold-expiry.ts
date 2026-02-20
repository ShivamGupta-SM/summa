// =============================================================================
// HOLD EXPIRY PLUGIN -- Automatic hold expiration
// =============================================================================
// Periodically expires holds that have passed their expiration date.
// In the original Encore ledger this was a 5-minute cron job.

import type { SummaPlugin } from "@summa/core";

// =============================================================================
// OPTIONS
// =============================================================================

export interface HoldExpiryOptions {
	/** Polling interval. Default: "5m" */
	interval?: string;
}

// =============================================================================
// PLUGIN FACTORY
// =============================================================================

export function holdExpiry(options?: HoldExpiryOptions): SummaPlugin {
	return {
		id: "hold-expiry",

		workers: [
			{
				id: "hold-expiry",
				description: "Expire holds past their expiration date",
				handler: async (ctx) => {
					const { expireHolds } = await import("../managers/hold-manager.js");
					const result = await expireHolds(ctx);
					if (result.expired > 0) {
						ctx.logger.info("Expired holds", { count: result.expired });
					}
				},
				interval: options?.interval ?? "5m",
				leaseRequired: false,
			},
		],
	};
}
