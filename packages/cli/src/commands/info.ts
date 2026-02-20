import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { arch, cpus, freemem, platform, release, totalmem } from "node:os";
import { join } from "node:path";
import * as p from "@clack/prompts";
import { Command } from "commander";
import pc from "picocolors";
import { detectPackageManager } from "../utils/detect-pm.js";
import { findConfigFile, getConfig } from "../utils/get-config.js";

// =============================================================================
// ADAPTER PACKAGE DETECTION
// =============================================================================

const ADAPTER_PACKAGES = [
	"@summa/drizzle-adapter",
	"@summa/prisma-adapter",
	"@summa/kysely-adapter",
	"@summa/memory-adapter",
] as const;

function detectInstalledAdapters(cwd: string): string[] {
	const installed: string[] = [];
	for (const pkg of ADAPTER_PACKAGES) {
		// Check both project-level and monorepo-level node_modules
		if (
			existsSync(join(cwd, "node_modules", ...pkg.split("/"))) ||
			existsSync(join(cwd, "..", "..", "node_modules", ...pkg.split("/")))
		) {
			installed.push(pkg);
		}
	}
	return installed;
}

// =============================================================================
// CLIPBOARD
// =============================================================================

function copyToClipboard(text: string): boolean {
	try {
		const os = platform();
		if (os === "darwin") {
			execSync("pbcopy", { input: text });
			return true;
		}
		if (os === "linux") {
			execSync("xclip -selection clipboard", { input: text });
			return true;
		}
		if (os === "win32") {
			execSync("clip", { input: text });
			return true;
		}
	} catch {
		// Clipboard not available
	}
	return false;
}

// =============================================================================
// INFO COMMAND
// =============================================================================

export const infoCommand = new Command("info")
	.description("Show environment and project information")
	.option("--json", "Output as JSON")
	.option("--copy", "Copy output to clipboard")
	.action(async (options: { json?: boolean; copy?: boolean }) => {
		const parent = infoCommand.parent;
		const cwd: string = parent?.opts().cwd ?? process.cwd();
		const configPath: string | undefined = parent?.opts().config;
		const version: string = parent?.version() ?? "unknown";

		// Gather system info
		const pm = detectPackageManager(cwd);
		const configFile = findConfigFile(cwd, configPath);
		const installedAdapters = detectInstalledAdapters(cwd);

		let adapterId: string | null = null;
		let currency: string | null = null;
		let plugins: string[] = [];
		let systemAccountKeys: string[] = [];
		let databaseUrl: string | null = null;

		if (configFile) {
			const config = await getConfig({ cwd, configPath });
			if (config) {
				const db = config.options.database;
				adapterId = typeof db === "object" && "id" in db ? (db as { id: string }).id : null;
				currency = config.options.currency ?? "USD";
				plugins = (config.options.plugins ?? []).map((pl) => pl.id);
				const sysAccts = config.options.systemAccounts;
				if (sysAccts && typeof sysAccts === "object") {
					systemAccountKeys = Object.keys(sysAccts);
				}
				// Check for DATABASE_URL (sanitized)
				if (typeof db === "object" && "connectionString" in db) {
					databaseUrl = "[REDACTED]";
				} else if (process.env.DATABASE_URL) {
					databaseUrl = "[REDACTED]";
				}
			}
		}

		const cpu = cpus();
		const info = {
			system: {
				os: `${platform()} ${arch()}`,
				osVersion: release(),
				cpuModel: cpu[0]?.model ?? "unknown",
				cpuCores: cpu.length,
				totalMemory: `${(totalmem() / 1024 / 1024 / 1024).toFixed(1)} GB`,
				freeMemory: `${(freemem() / 1024 / 1024 / 1024).toFixed(1)} GB`,
			},
			node: process.version,
			packageManager: pm,
			summa: {
				version,
				configFile: configFile ?? null,
				adapter: adapterId,
				currency,
				plugins,
				systemAccounts: systemAccountKeys,
				databaseUrl,
				installedAdapters,
			},
		};

		if (options.json) {
			const jsonOutput = JSON.stringify(info, null, 2);
			process.stdout.write(`${jsonOutput}\n`);
			if (options.copy) {
				if (copyToClipboard(jsonOutput)) {
					console.error(pc.green("Copied to clipboard"));
				} else {
					console.error(pc.yellow("Could not copy to clipboard"));
				}
			}
			return;
		}

		p.intro(pc.bgCyan(pc.black(" summa info ")));

		// System
		p.log.step(pc.bold("System"));
		const sysLines = [
			`${pc.bold("OS:")}             ${info.system.os} (${info.system.osVersion})`,
			`${pc.bold("CPU:")}            ${info.system.cpuModel} (${info.system.cpuCores} cores)`,
			`${pc.bold("Memory:")}         ${info.system.totalMemory} total, ${info.system.freeMemory} free`,
			`${pc.bold("Node:")}           ${info.node}`,
			`${pc.bold("Package mgr:")}   ${info.packageManager}`,
		];
		p.note(sysLines.join("\n"), "System");

		// Summa
		p.log.step(pc.bold("Summa"));
		const summaLines = [
			`${pc.bold("Version:")}        v${info.summa.version}`,
			`${pc.bold("Config:")}         ${info.summa.configFile ?? pc.dim("not found")}`,
			`${pc.bold("Adapter:")}        ${info.summa.adapter ?? pc.dim("n/a")}`,
			`${pc.bold("Currency:")}       ${info.summa.currency ?? pc.dim("n/a")}`,
			`${pc.bold("Plugins:")}        ${info.summa.plugins.length > 0 ? info.summa.plugins.join(", ") : pc.dim("none")}`,
			`${pc.bold("Sys accounts:")}  ${info.summa.systemAccounts.length > 0 ? info.summa.systemAccounts.join(", ") : pc.dim("none")}`,
			`${pc.bold("Database URL:")}  ${info.summa.databaseUrl ?? pc.dim("not set")}`,
			`${pc.bold("Adapters:")}       ${info.summa.installedAdapters.length > 0 ? info.summa.installedAdapters.join(", ") : pc.dim("none installed")}`,
		];
		p.note(summaLines.join("\n"), "Summa");

		if (options.copy) {
			const jsonOutput = JSON.stringify(info, null, 2);
			const plainText = jsonOutput;

			if (copyToClipboard(plainText)) {
				p.log.success("Copied to clipboard");
			} else {
				p.log.warning("Could not copy to clipboard");
			}
		}

		p.outro(pc.dim("Run with --json for machine-readable output"));
	});
