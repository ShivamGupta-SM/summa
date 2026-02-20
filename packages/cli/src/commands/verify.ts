import * as p from "@clack/prompts";
import { Command } from "commander";
import pc from "picocolors";

export const verifyCommand = new Command("verify")
	.description("Verify ledger integrity")
	.option("--chain", "Verify event hash chain integrity")
	.option("--balances", "Verify double-entry balance integrity")
	.option("--url <url>", "PostgreSQL connection URL (or set DATABASE_URL)")
	.action(async (options: { chain?: boolean; balances?: boolean; url?: string }) => {
		const runAll = !options.chain && !options.balances;

		p.intro(pc.bgCyan(pc.black(" summa verify ")));

		const dbUrl = options.url ?? process.env.DATABASE_URL;
		if (!dbUrl) {
			p.log.error(`${pc.red("No DATABASE_URL")} ${pc.dim("set DATABASE_URL or use --url")}`);
			p.outro(pc.dim("Cannot verify without a database connection."));
			process.exitCode = 1;
			return;
		}

		let pg: typeof import("pg");
		try {
			pg = await import("pg");
		} catch {
			p.log.error(`${pc.red("pg not installed")} ${pc.dim("run: pnpm add -D pg")}`);
			p.outro(pc.dim("Install pg to connect to the database."));
			process.exitCode = 1;
			return;
		}

		const client = new pg.default.Client({ connectionString: dbUrl });
		let hasFailure = false;

		try {
			await client.connect();

			// ==================================================================
			// BALANCE VERIFICATION
			// ==================================================================
			if (options.balances || runAll) {
				p.log.step(pc.bold("Double-Entry Balance Verification"));

				const s = p.spinner();
				s.start("Checking per-transaction debit/credit balance...");

				// Check 1: Per-transaction debit == credit
				const imbalancedResult = await client.query(`
					SELECT
						e.transaction_id,
						SUM(CASE WHEN e.entry_type = 'CREDIT' THEN e.amount ELSE 0 END) AS total_credits,
						SUM(CASE WHEN e.entry_type = 'DEBIT' THEN e.amount ELSE 0 END) AS total_debits
					FROM entry_record e
					GROUP BY e.transaction_id
					HAVING SUM(CASE WHEN e.entry_type = 'CREDIT' THEN e.amount ELSE 0 END)
					    != SUM(CASE WHEN e.entry_type = 'DEBIT' THEN e.amount ELSE 0 END)
					LIMIT 10
				`);

				if (imbalancedResult.rows.length === 0) {
					s.stop(`${pc.green("PASS")} All transactions have balanced entries`);
				} else {
					s.stop(
						`${pc.red("FAIL")} ${imbalancedResult.rows.length} transaction(s) with imbalanced entries`,
					);
					for (const row of imbalancedResult.rows) {
						p.log.error(
							`  txn ${String(row.transaction_id).slice(0, 8)}... credits=${row.total_credits} debits=${row.total_debits}`,
						);
					}
					hasFailure = true;
				}

				// Check 2: Grand total (user + system + hot) == 0
				const s2 = p.spinner();
				s2.start("Checking global balance invariant...");

				const userResult = await client.query(
					`SELECT COALESCE(SUM(balance), 0)::bigint AS total FROM account_balance`,
				);
				const sysResult = await client.query(
					`SELECT COALESCE(SUM(balance), 0)::bigint AS total FROM system_account`,
				);
				const hotResult = await client.query(
					`SELECT COALESCE(SUM(amount), 0)::bigint AS total FROM hot_account_entry WHERE status = 'pending'`,
				);

				const userTotal = Number(userResult.rows[0]?.total ?? 0);
				const systemTotal = Number(sysResult.rows[0]?.total ?? 0);
				const hotTotal = Number(hotResult.rows[0]?.total ?? 0);
				const grandTotal = userTotal + systemTotal + hotTotal;

				if (grandTotal === 0) {
					s2.stop(
						`${pc.green("PASS")} Global balance: user(${userTotal}) + system(${systemTotal}) + hot(${hotTotal}) = 0`,
					);
				} else {
					s2.stop(
						`${pc.red("FAIL")} Global balance: user(${userTotal}) + system(${systemTotal}) + hot(${hotTotal}) = ${grandTotal}`,
					);
					hasFailure = true;
				}

				// Check 3: Duplicate entries
				const s3 = p.spinner();
				s3.start("Checking for duplicate entries...");

				const dupResult = await client.query(`
					SELECT transaction_id, entry_type, COUNT(*) AS cnt
					FROM entry_record
					WHERE is_hot_account = false
					GROUP BY transaction_id, account_id, system_account_id, entry_type
					HAVING COUNT(*) > 1
					LIMIT 10
				`);

				if (dupResult.rows.length === 0) {
					s3.stop(`${pc.green("PASS")} No duplicate entries found`);
				} else {
					s3.stop(`${pc.red("FAIL")} ${dupResult.rows.length} duplicate entry group(s) found`);
					hasFailure = true;
				}
			}

			// ==================================================================
			// HASH CHAIN VERIFICATION
			// ==================================================================
			if (options.chain || runAll) {
				p.log.step(pc.bold("Hash Chain Verification"));

				// Verify block checkpoints
				const s4 = p.spinner();
				s4.start("Checking block checkpoint chain linkage...");

				const blocksResult = await client.query(`
					SELECT id, block_sequence, block_hash, prev_block_id, prev_block_hash
					FROM block_checkpoint
					ORDER BY block_sequence ASC
				`);

				const blocks = blocksResult.rows;
				let chainBroken = false;

				if (blocks.length === 0) {
					s4.stop(
						`${pc.yellow("SKIP")} No block checkpoints found ${pc.dim("(run reconciliation first)")}`,
					);
				} else {
					for (let i = 1; i < blocks.length; i++) {
						const curr = blocks[i];
						const prev = blocks[i - 1];
						if (!curr || !prev) continue;

						if (curr.prev_block_hash !== prev.block_hash) {
							p.log.error(
								`  Block #${curr.block_sequence}: prev_block_hash mismatch (expected ${String(prev.block_hash).slice(0, 12)}..., got ${String(curr.prev_block_hash).slice(0, 12)}...)`,
							);
							chainBroken = true;
						}
						if (curr.prev_block_id !== prev.id) {
							p.log.error(`  Block #${curr.block_sequence}: prev_block_id mismatch`);
							chainBroken = true;
						}
					}

					if (chainBroken) {
						s4.stop(`${pc.red("FAIL")} Block chain linkage broken`);
						hasFailure = true;
					} else {
						s4.stop(`${pc.green("PASS")} ${blocks.length} block(s) verified, chain intact`);
					}
				}

				// Verify event hash chain per aggregate (sample check)
				const s5 = p.spinner();
				s5.start("Sampling event hash chains...");

				const aggregateResult = await client.query(`
					SELECT DISTINCT aggregate_type, aggregate_id
					FROM ledger_event
					ORDER BY aggregate_type, aggregate_id
					LIMIT 50
				`);

				let eventChainErrors = 0;
				let eventsChecked = 0;

				for (const agg of aggregateResult.rows) {
					const eventsResult = await client.query(
						`SELECT id, aggregate_version, hash, prev_hash
						 FROM ledger_event
						 WHERE aggregate_type = $1 AND aggregate_id = $2
						 ORDER BY aggregate_version ASC`,
						[agg.aggregate_type, agg.aggregate_id],
					);

					const events = eventsResult.rows;
					for (let i = 1; i < events.length; i++) {
						const curr = events[i];
						const prev = events[i - 1];
						if (!curr || !prev) continue;
						eventsChecked++;

						if (curr.prev_hash !== prev.hash) {
							eventChainErrors++;
							if (eventChainErrors <= 5) {
								p.log.error(
									`  ${agg.aggregate_type}:${String(agg.aggregate_id).slice(0, 8)}... v${curr.aggregate_version}: prev_hash mismatch`,
								);
							}
						}
					}
				}

				if (aggregateResult.rows.length === 0) {
					s5.stop(`${pc.yellow("SKIP")} No events found`);
				} else if (eventChainErrors === 0) {
					s5.stop(
						`${pc.green("PASS")} ${aggregateResult.rows.length} aggregate(s), ${eventsChecked} link(s) verified`,
					);
				} else {
					s5.stop(
						`${pc.red("FAIL")} ${eventChainErrors} broken link(s) across ${aggregateResult.rows.length} aggregate(s)`,
					);
					hasFailure = true;
				}
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			p.log.error(`Connection failed: ${pc.dim(message)}`);
			hasFailure = true;
		} finally {
			await client.end().catch(() => {});
		}

		if (hasFailure) {
			p.outro(pc.red("Verification found issues."));
			process.exitCode = 1;
		} else {
			p.outro(pc.green("All verification checks passed."));
		}
	});
