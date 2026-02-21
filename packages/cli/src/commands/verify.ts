import * as p from "@clack/prompts";
import { Command } from "commander";
import pc from "picocolors";
import { getConfig } from "../utils/get-config.js";

export const verifyCommand = new Command("verify")
	.description("Verify ledger integrity")
	.option("--chain", "Verify event hash chain integrity")
	.option("--balances", "Verify double-entry balance integrity")
	.option("--merkle", "Verify Merkle tree integrity for recent blocks")
	.option("--url <url>", "PostgreSQL connection URL (or set DATABASE_URL)")
	.action(
		async (options: { chain?: boolean; balances?: boolean; merkle?: boolean; url?: string }) => {
			const parent = verifyCommand.parent;
			const cwd: string = parent?.opts().cwd ?? process.cwd();
			const configFlag: string | undefined = parent?.opts().config;

			const runAll = !options.chain && !options.balances && !options.merkle;

			p.intro(pc.bgCyan(pc.black(" summa verify ")));

			// Try loading config for DATABASE_URL extraction and schema
			let configDbUrl: string | undefined;
			let schema = "summa";
			const config = await getConfig({ cwd, configPath: configFlag });
			if (config?.options) {
				const db = config.options.database;
				if (typeof db === "object" && "connectionString" in db) {
					configDbUrl = db.connectionString as string;
				}
				if (typeof config.options.schema === "string" && config.options.schema.length > 0) {
					schema = config.options.schema;
				}
			}
			const t = (table: string) => (schema === "public" ? `"${table}"` : `"${schema}"."${table}"`);

			const dbUrl = options.url ?? configDbUrl ?? process.env.DATABASE_URL;
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
			let passed = 0;
			let failed = 0;
			let skipped = 0;

			try {
				await client.connect();

				// ==================================================================
				// BALANCE VERIFICATION
				// ==================================================================
				if (options.balances || runAll) {
					p.log.step(pc.bold("Double-Entry Balance Verification"));

					// Check 1: Per-transaction debit == credit
					const s = p.spinner();
					s.start("Checking per-transaction debit/credit balance...");

					const imbalancedResult = await client.query(`
					SELECT
						e.transaction_id,
						SUM(CASE WHEN e.entry_type = 'CREDIT' THEN e.amount ELSE 0 END) AS total_credits,
						SUM(CASE WHEN e.entry_type = 'DEBIT' THEN e.amount ELSE 0 END) AS total_debits
					FROM ${t("entry_record")} e
					GROUP BY e.transaction_id
					HAVING SUM(CASE WHEN e.entry_type = 'CREDIT' THEN e.amount ELSE 0 END)
					    != SUM(CASE WHEN e.entry_type = 'DEBIT' THEN e.amount ELSE 0 END)
					LIMIT 10
				`);

					if (imbalancedResult.rows.length === 0) {
						s.stop(`${pc.green("PASS")} All transactions have balanced entries`);
						passed++;
					} else {
						s.stop(
							`${pc.red("FAIL")} ${imbalancedResult.rows.length} transaction(s) with imbalanced entries`,
						);
						for (const row of imbalancedResult.rows) {
							p.log.error(
								`  txn ${String(row.transaction_id).slice(0, 8)}... credits=${row.total_credits} debits=${row.total_debits}`,
							);
						}
						failed++;
					}

					// Check 2: Grand total (user + system + hot) == 0
					const s2 = p.spinner();
					s2.start("Checking global balance invariant...");

					const userResult = await client.query(
						`SELECT COALESCE(SUM(v.balance), 0)::bigint AS total
					 FROM ${t("account_balance")} a
					 JOIN LATERAL (
					   SELECT balance FROM ${t("account_balance_version")}
					   WHERE account_id = a.id ORDER BY version DESC LIMIT 1
					 ) v ON true`,
					);
					const sysResult = await client.query(
						`SELECT COALESCE(SUM(v.balance), 0)::bigint AS total
					 FROM ${t("system_account")} sa
					 JOIN LATERAL (
					   SELECT balance FROM ${t("system_account_version")}
					   WHERE system_account_id = sa.id ORDER BY version DESC LIMIT 1
					 ) v ON true`,
					);
					const hotResult = await client.query(
						`SELECT COALESCE(SUM(amount), 0)::bigint AS total FROM ${t("hot_account_entry")} WHERE status = 'pending'`,
					);

					const userTotal = Number(userResult.rows[0]?.total ?? 0);
					const systemTotal = Number(sysResult.rows[0]?.total ?? 0);
					const hotTotal = Number(hotResult.rows[0]?.total ?? 0);
					const grandTotal = userTotal + systemTotal + hotTotal;

					if (grandTotal === 0) {
						s2.stop(
							`${pc.green("PASS")} Global balance: user(${userTotal}) + system(${systemTotal}) + hot(${hotTotal}) = 0`,
						);
						passed++;
					} else {
						s2.stop(
							`${pc.red("FAIL")} Global balance: user(${userTotal}) + system(${systemTotal}) + hot(${hotTotal}) = ${grandTotal}`,
						);
						failed++;
					}

					// Check 3: Duplicate entries
					const s3 = p.spinner();
					s3.start("Checking for duplicate entries...");

					const dupResult = await client.query(`
					SELECT transaction_id, entry_type, COUNT(*) AS cnt
					FROM ${t("entry_record")}
					WHERE is_hot_account = false
					GROUP BY transaction_id, account_id, system_account_id, entry_type
					HAVING COUNT(*) > 1
					LIMIT 10
				`);

					if (dupResult.rows.length === 0) {
						s3.stop(`${pc.green("PASS")} No duplicate entries found`);
						passed++;
					} else {
						s3.stop(`${pc.red("FAIL")} ${dupResult.rows.length} duplicate entry group(s) found`);
						failed++;
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
					FROM ${t("block_checkpoint")}
					ORDER BY block_sequence ASC
				`);

					const blocks = blocksResult.rows;
					let chainBroken = false;

					if (blocks.length === 0) {
						s4.stop(
							`${pc.yellow("SKIP")} No block checkpoints found ${pc.dim("(run reconciliation first)")}`,
						);
						skipped++;
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
							failed++;
						} else {
							s4.stop(`${pc.green("PASS")} ${blocks.length} block(s) verified, chain intact`);
							passed++;
						}
					}

					// Verify event hash chain per aggregate (sample check)
					const s5 = p.spinner();
					const sampleLimit = 50;
					s5.start(`Sampling event hash chains (${sampleLimit} aggregates)...`);

					const aggregateTotalResult = await client.query(
						`SELECT COUNT(DISTINCT (aggregate_type, aggregate_id)) as total FROM ${t("ledger_event")}`,
					);
					const totalAggregates = Number(aggregateTotalResult.rows[0]?.total ?? 0);
					if (totalAggregates > sampleLimit) {
						p.log.warn(
							`Verifying ${sampleLimit} of ${totalAggregates} aggregates. This is a sample check, not a full audit.`,
						);
					}

					const aggregateResult = await client.query(`
					SELECT DISTINCT aggregate_type, aggregate_id
					FROM ${t("ledger_event")}
					ORDER BY aggregate_type, aggregate_id
					LIMIT ${sampleLimit}
				`);

					let eventChainErrors = 0;
					let eventsChecked = 0;

					for (const agg of aggregateResult.rows) {
						const eventsResult = await client.query(
							`SELECT id, aggregate_version, hash, prev_hash
						 FROM ${t("ledger_event")}
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
						skipped++;
					} else if (eventChainErrors === 0) {
						s5.stop(
							`${pc.green("PASS")} ${aggregateResult.rows.length} aggregate(s), ${eventsChecked} link(s) verified`,
						);
						passed++;
					} else {
						s5.stop(
							`${pc.red("FAIL")} ${eventChainErrors} broken link(s) across ${aggregateResult.rows.length} aggregate(s)`,
						);
						failed++;
					}
				}
				// ==================================================================
				// MERKLE TREE VERIFICATION
				// ==================================================================
				if (options.merkle || runAll) {
					p.log.step(pc.bold("Merkle Tree Verification"));

					const s6 = p.spinner();
					s6.start("Checking Merkle roots for recent block checkpoints...");

					// Get recent blocks that have merkle_root
					const merkleBlocksResult = await client.query(`
					SELECT id, block_sequence, from_event_sequence, to_event_sequence, merkle_root
					FROM ${t("block_checkpoint")}
					WHERE merkle_root IS NOT NULL
					ORDER BY block_sequence DESC
					LIMIT 10
				`);

					const merkleBlocks = merkleBlocksResult.rows;
					if (merkleBlocks.length === 0) {
						s6.stop(
							`${pc.yellow("SKIP")} No blocks with Merkle roots found ${pc.dim("(create block checkpoints first)")}`,
						);
						skipped++;
					} else {
						let merkleErrors = 0;

						for (const block of merkleBlocks) {
							// Collect event hashes for this block
							const eventHashesResult = await client.query(
								`SELECT hash FROM ${t("ledger_event")}
							 WHERE sequence_number >= $1 AND sequence_number <= $2
							 ORDER BY sequence_number ASC`,
								[block.from_event_sequence, block.to_event_sequence],
							);

							const leafHashes: string[] = eventHashesResult.rows.map(
								(r: { hash: string }) => r.hash,
							);

							// Recompute Merkle root
							const { createHash: ch } = await import("node:crypto");
							let level = [...leafHashes];
							while (level.length > 1) {
								const nextLevel: string[] = [];
								for (let i = 0; i < level.length; i += 2) {
									const left = level[i]!;
									const right = i + 1 < level.length ? level[i + 1]! : left;
									nextLevel.push(
										ch("sha256")
											.update(left + right)
											.digest("hex"),
									);
								}
								level = nextLevel;
							}
							const computedRoot =
								level.length > 0 ? level[0]! : ch("sha256").update("").digest("hex");

							if (computedRoot !== block.merkle_root) {
								merkleErrors++;
								p.log.error(
									`  Block #${block.block_sequence}: Merkle root mismatch (stored=${String(block.merkle_root).slice(0, 12)}..., computed=${computedRoot.slice(0, 12)}...)`,
								);
							}
						}

						if (merkleErrors === 0) {
							s6.stop(`${pc.green("PASS")} ${merkleBlocks.length} block(s) Merkle roots verified`);
							passed++;
						} else {
							s6.stop(`${pc.red("FAIL")} ${merkleErrors} block(s) with Merkle root mismatch`);
							failed++;
						}
					}

					// Check that merkle_node table is consistent with block_checkpoint
					const s7 = p.spinner();
					s7.start("Checking Merkle node counts...");

					const nodeCountResult = await client.query(`
					SELECT bc.id, bc.block_sequence, bc.event_count,
					       (SELECT COUNT(*) FROM ${t("merkle_node")} mn WHERE mn.block_id = bc.id AND mn.level = 0) AS leaf_count
					FROM ${t("block_checkpoint")} bc
					WHERE bc.merkle_root IS NOT NULL
					ORDER BY bc.block_sequence DESC
					LIMIT 10
				`);

					let nodeCountErrors = 0;
					for (const row of nodeCountResult.rows) {
						if (Number(row.leaf_count) !== Number(row.event_count)) {
							nodeCountErrors++;
							p.log.error(
								`  Block #${row.block_sequence}: leaf nodes (${row.leaf_count}) != event count (${row.event_count})`,
							);
						}
					}

					if (nodeCountResult.rows.length === 0) {
						s7.stop(`${pc.yellow("SKIP")} No Merkle node data found`);
						skipped++;
					} else if (nodeCountErrors === 0) {
						s7.stop(
							`${pc.green("PASS")} ${nodeCountResult.rows.length} block(s) have correct leaf node counts`,
						);
						passed++;
					} else {
						s7.stop(`${pc.red("FAIL")} ${nodeCountErrors} block(s) with leaf count mismatch`);
						failed++;
					}
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				p.log.error(`Connection failed: ${pc.dim(message)}`);
				failed++;
			} finally {
				await client.end().catch(() => {});
			}

			// Summary
			const summary = [
				pc.green(`${passed} passed`),
				...(failed > 0 ? [pc.red(`${failed} failed`)] : []),
				...(skipped > 0 ? [pc.yellow(`${skipped} skipped`)] : []),
			].join(pc.dim(" / "));

			if (failed > 0) {
				p.outro(`${pc.red("Verification found issues.")} ${pc.dim(`(${summary})`)}`);
				process.exitCode = 1;
			} else {
				p.outro(`${pc.green("All checks passed.")} ${pc.dim(`(${summary})`)}`);
			}
		},
	);
