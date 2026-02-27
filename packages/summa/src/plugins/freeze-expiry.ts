// =============================================================================
// FREEZE EXPIRY PLUGIN — Auto-unfreeze accounts after TTL
// =============================================================================
// Periodically checks for accounts with a frozen_until timestamp in the past
// and automatically unfreezes them by updating the account row directly
// and logging the status transition to entity_status_log.

import { computeBalanceChecksum, type SummaPlugin } from "@summa-ledger/core";
import { createTableResolver } from "@summa-ledger/core/db";

// =============================================================================
// OPTIONS
// =============================================================================

export interface FreezeExpiryOptions {
	/** Polling interval. Default: "1m" */
	interval?: string;
}

// =============================================================================
// PLUGIN FACTORY
// =============================================================================

export function freezeExpiry(options?: FreezeExpiryOptions): SummaPlugin {
	return {
		id: "freeze-expiry",

		schema: {
			// Extend the account table with frozen_until
			account: {
				extend: true,
				columns: {
					frozen_until: { type: "timestamp" },
				},
			},
		},

		workers: [
			{
				id: "freeze-expiry",
				description: "Auto-unfreeze accounts past their frozen_until timestamp",
				handler: async (ctx) => {
					const t = createTableResolver(ctx.options.schema);

					// Find frozen accounts whose freeze period has expired
					const candidates = await ctx.adapter.raw<{
						id: string;
						holder_id: string;
						version: number;
						balance: number;
						credit_balance: number;
						debit_balance: number;
						pending_debit: number;
						pending_credit: number;
					}>(
						`SELECT id, holder_id, version, balance, credit_balance,
                    debit_balance, pending_debit, pending_credit
             FROM ${t("account")}
             WHERE status = 'frozen'
               AND frozen_until IS NOT NULL
               AND frozen_until <= NOW()
             LIMIT 100`,
						[],
					);

					if (candidates.length === 0) return;

					let unfrozen = 0;
					for (const c of candidates) {
						try {
							await ctx.adapter.transaction(async (tx) => {
								// Lock the account row
								const lockedRows = await tx.raw<{
									id: string;
									version: number;
									balance: number;
									credit_balance: number;
									debit_balance: number;
									pending_debit: number;
									pending_credit: number;
									status: string;
									frozen_until: string | null;
								}>(
									`SELECT id, version, balance, credit_balance, debit_balance,
                            pending_debit, pending_credit, status, frozen_until
                     FROM ${t("account")}
                     WHERE id = $1 FOR UPDATE`,
									[c.id],
								);
								const row = lockedRows[0];
								if (!row || row.status !== "frozen" || !row.frozen_until) return;
								if (new Date(row.frozen_until) > new Date()) return;

								// Compute new version and checksum
								const newVersion = Number(row.version) + 1;
								const checksum = computeBalanceChecksum(
									{
										balance: Number(row.balance),
										creditBalance: Number(row.credit_balance),
										debitBalance: Number(row.debit_balance),
										pendingDebit: Number(row.pending_debit),
										pendingCredit: Number(row.pending_credit),
										lockVersion: newVersion,
									},
									ctx.options.advanced.hmacSecret,
								);

								// UPDATE account: set active, clear freeze fields
								await tx.raw(
									`UPDATE ${t("account")} SET
                     status = $1, version = $2, checksum = $3,
                     freeze_reason = NULL, frozen_at = NULL, frozen_by = NULL, frozen_until = NULL
                   WHERE id = $4 AND version = $5`,
									["active", newVersion, checksum, row.id, Number(row.version)],
								);

								// Log status transition to entity_status_log
								await tx.raw(
									`INSERT INTO ${t("entity_status_log")} (entity_type, entity_id, status, previous_status, reason, metadata)
                   VALUES ($1, $2, $3, $4, $5, $6)`,
									[
										"account",
										row.id,
										"active",
										"frozen",
										"Freeze period expired",
										JSON.stringify({ autoUnfreeze: true }),
									],
								);

								// Outbox event
								await tx.raw(
									`INSERT INTO ${t("outbox")} (topic, payload)
                   VALUES ($1, $2)`,
									[
										"ledger-account-auto-unfrozen",
										JSON.stringify({
											accountId: row.id,
											holderId: c.holder_id,
											reason: "Freeze period expired",
										}),
									],
								);

								unfrozen++;
							});
						} catch (err) {
							ctx.logger.error("Failed to auto-unfreeze account", {
								accountId: c.id,
								error: err instanceof Error ? err.message : String(err),
							});
						}
					}

					if (unfrozen > 0) {
						ctx.logger.info("Auto-unfroze expired accounts", { count: unfrozen });
					}
				},
				interval: options?.interval ?? "1m",
				leaseRequired: false,
			},
		],
	};
}
