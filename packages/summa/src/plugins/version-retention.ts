// =============================================================================
// VERSION RETENTION PLUGIN -- DEPRECATED (v2)
// =============================================================================
// In v2, the account_balance_version table no longer exists. Balances are
// mutable directly on the `account` table, so version retention is unnecessary.
//
// This plugin is kept as a no-op for backwards compatibility. It logs a
// deprecation warning on init and does nothing else.

import type { SummaPlugin } from "@summa-ledger/core";

// =============================================================================
// TYPES (kept for backwards compatibility)
// =============================================================================

export interface VersionRetentionOptions {
	/** @deprecated No longer used in v2 */
	retainVersions?: number;
	/** @deprecated No longer used in v2 */
	retainDays?: number;
	/** @deprecated No longer used in v2 */
	archiveTable?: boolean;
	/** @deprecated No longer used in v2 */
	batchSize?: number;
	/** @deprecated No longer used in v2 */
	interval?: string;
}

// =============================================================================
// PLUGIN FACTORY
// =============================================================================

export function versionRetention(_options?: VersionRetentionOptions): SummaPlugin {
	return {
		id: "version-retention",

		init: (ctx) => {
			ctx.logger.warn(
				"version-retention plugin is deprecated in v2 — account_balance_version table no longer exists",
			);
		},
	};
}
