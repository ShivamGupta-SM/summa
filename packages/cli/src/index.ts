#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { initCommand } from "./commands/init.js";
import { migrateCommand } from "./commands/migrate.js";
import { statusCommand } from "./commands/status.js";
import { verifyCommand } from "./commands/verify.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf-8"));

const program = new Command()
	.name("summa")
	.description("CLI for summa — event-sourced double-entry ledger")
	.version(pkg.version);

program.addCommand(initCommand);
program.addCommand(migrateCommand);
program.addCommand(verifyCommand);
program.addCommand(statusCommand);

program.parse();
