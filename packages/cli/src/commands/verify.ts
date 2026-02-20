import * as p from "@clack/prompts";
import { Command } from "commander";
import pc from "picocolors";

export const verifyCommand = new Command("verify")
	.description("Verify ledger integrity")
	.option("--chain", "Verify event hash chain integrity")
	.option("--balances", "Verify double-entry balance integrity")
	.action(async (options: { chain?: boolean; balances?: boolean }) => {
		const runAll = !options.chain && !options.balances;

		p.intro(pc.bgCyan(pc.black(" summa verify ")));

		if (options.chain || runAll) {
			p.log.step(pc.bold("Hash Chain Verification"));
			p.log.message(
				[
					"Verifies that every event in the event store has a valid",
					"cryptographic hash chain. Each event's hash depends on the",
					"previous event, ensuring no event can be modified or deleted",
					"without detection.",
				].join("\n"),
			);
			p.log.warning(
				[
					`${pc.yellow("scaffold")} — To run verification, load your config and call:`,
					pc.dim("  const result = await summa.events.verifyChain(aggregateType, aggregateId);"),
				].join("\n"),
			);
		}

		if (options.balances || runAll) {
			p.log.step(pc.bold("Double-Entry Balance Verification"));
			p.log.message(
				[
					"Verifies the fundamental accounting invariant: for every posted",
					"transaction, the sum of all debits must equal the sum of all",
					"credits. Any imbalance indicates data corruption.",
				].join("\n"),
			);
			p.log.warning(
				[
					`${pc.yellow("scaffold")} — To run balance verification, load your config`,
					pc.dim("  and query all posted transactions, then assert: totalDebits === totalCredits"),
				].join("\n"),
			);
		}

		p.outro(
			pc.dim("Full verification requires a database connection. Configure summa.config.ts first."),
		);
	});
