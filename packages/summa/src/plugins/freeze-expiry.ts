// =============================================================================
// FREEZE EXPIRY PLUGIN — Auto-unfreeze accounts after TTL (APPEND-ONLY)
// =============================================================================
// Periodically checks for accounts with a frozen_until timestamp in the past
// and automatically unfreezes them by inserting a new account_balance_version
// row with active status.

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
			// Extend the version table (not the immutable parent) with frozen_until
			accountBalanceVersion: {
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

					// Find frozen accounts with expired frozen_until using LATERAL JOIN
					const candidates = await ctx.adapter.raw<{
						account_id: string;
						holder_id: string;
						version: number;
						balance: number;
						credit_balance: number;
						debit_balance: number;
						pending_debit: number;
						pending_credit: number;
					}>(
						`SELECT a.id AS account_id, a.holder_id, v.version, v.balance,
                    v.credit_balance, v.debit_balance, v.pending_debit, v.pending_credit
             FROM ${t("account_balance")} a
             JOIN LATERAL (
               SELECT * FROM ${t("account_balance_version")}
               WHERE account_id = a.id
               ORDER BY version DESC LIMIT 1
             ) v ON true
             WHERE v.status = 'frozen'
               AND v.frozen_until IS NOT NULL
               AND v.frozen_until <= NOW()
             LIMIT 100`,
						[],
					);

					if (candidates.length === 0) return;

					let unfrozen = 0;
					for (const c of candidates) {
						try {
							await ctx.adapter.transaction(async (tx) => {
								// Lock the immutable parent
								await tx.raw(`SELECT id FROM ${t("account_balance")} WHERE id = $1 FOR UPDATE`, [
									c.account_id,
								]);

								// Re-read latest version inside lock
								const vRows = await tx.raw<{
									version: number;
									balance: number;
									credit_balance: number;
									debit_balance: number;
									pending_debit: number;
									pending_credit: number;
									status: string;
									frozen_until: string | null;
								}>(
									`SELECT version, balance, credit_balance, debit_balance,
                            pending_debit, pending_credit, status, frozen_until
                     FROM ${t("account_balance_version")}
                     WHERE account_id = $1 ORDER BY version DESC LIMIT 1`,
									[c.account_id],
								);
								const v = vRows[0];
								if (!v || v.status !== "frozen" || !v.frozen_until) return;
								if (new Date(v.frozen_until) > new Date()) return;

								// INSERT new version with active status (APPEND-ONLY)
								const newVersion = Number(v.version) + 1;
								const checksum = computeBalanceChecksum(
									{
										balance: Number(v.balance),
										creditBalance: Number(v.credit_balance),
										debitBalance: Number(v.debit_balance),
										pendingDebit: Number(v.pending_debit),
										pendingCredit: Number(v.pending_credit),
										lockVersion: newVersion,
									},
									ctx.options.advanced.hmacSecret,
								);

								await tx.raw(
									`INSERT INTO ${t("account_balance_version")} (
                     account_id, version, balance, credit_balance, debit_balance,
                     pending_credit, pending_debit, status, checksum,
                     change_type
                   ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
									[
										c.account_id,
										newVersion,
										Number(v.balance),
										Number(v.credit_balance),
										Number(v.debit_balance),
										Number(v.pending_credit),
										Number(v.pending_debit),
										"active",
										checksum,
										"auto_unfreeze",
									],
								);

								// Outbox event
								await tx.raw(
									`INSERT INTO ${t("outbox")} (topic, payload)
                   VALUES ($1, $2)`,
									[
										"ledger-account-auto-unfrozen",
										JSON.stringify({
											accountId: c.account_id,
											holderId: c.holder_id,
											reason: "Freeze period expired",
										}),
									],
								);

								unfrozen++;
							});
						} catch (err) {
							ctx.logger.error("Failed to auto-unfreeze account", {
								accountId: c.account_id,
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
