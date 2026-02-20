import { existsSync } from "node:fs";
import { resolve } from "node:path";
import * as p from "@clack/prompts";
import { Command } from "commander";
import pc from "picocolors";

export const statusCommand = new Command("status")
	.description("Show current summa system status")
	.action(async () => {
		p.intro(pc.bgCyan(pc.black(" summa status ")));

		const configPath = resolve(process.cwd(), "summa.config.ts");
		const hasConfig = existsSync(configPath);

		// Configuration
		p.log.step(pc.bold("Configuration"));
		if (hasConfig) {
			p.log.success(`  Config file:   ${pc.green("found")} ${pc.dim("summa.config.ts")}`);
		} else {
			p.log.warning(
				`  Config file:   ${pc.yellow("missing")} ${pc.dim("run summa init to create one")}`,
			);
		}

		// Database
		p.log.step(pc.bold("Database"));
		p.log.warning(`  Connection:    ${pc.yellow("scaffold")} ${pc.dim("not connected")}`);
		p.log.warning(`  Adapter:       ${pc.yellow("scaffold")} ${pc.dim("unknown")}`);

		// Ledger Statistics
		p.log.step(pc.bold("Ledger Statistics"));
		const stats = ["Accounts", "Transactions", "Active holds", "Event count"];
		for (const stat of stats) {
			p.log.warning(
				`  ${`${stat}:`.padEnd(15)} ${pc.yellow("scaffold")} ${pc.dim("requires db connection")}`,
			);
		}

		// Integrity
		p.log.step(pc.bold("Integrity"));
		p.log.warning(`  Hash chain:    ${pc.yellow("scaffold")} ${pc.dim("not verified")}`);
		p.log.warning(`  Balance check: ${pc.yellow("scaffold")} ${pc.dim("not verified")}`);
		p.log.warning(`  Last recon:    ${pc.yellow("scaffold")} ${pc.dim("never")}`);

		p.outro(pc.dim("Full status requires a database connection. Configure summa.config.ts first."));
	});
