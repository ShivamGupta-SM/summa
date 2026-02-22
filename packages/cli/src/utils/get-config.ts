// =============================================================================
// Config loader — uses c12 (UnJS) + jiti for runtime TS transpilation
// =============================================================================
// Discovers and loads the user's summa config file (e.g. summa.config.ts).
// Handles named export `summa`, default export, or a plain options object.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SummaOptions } from "@summa/core";
import { loadConfig } from "c12";
import { createJiti } from "jiti";
import { possibleConfigPaths } from "./config-paths.js";

export interface ResolvedSummaConfig {
	/** The resolved SummaOptions from the config file */
	options: SummaOptions;
	/** Absolute path of the config file that was loaded */
	configFile: string;
}

/**
 * Load and resolve the summa config file.
 *
 * Resolution order:
 * 1. If `configPath` is provided (--config flag), use it directly.
 * 2. Otherwise, scan `possibleConfigPaths` from project root.
 *
 * The config file should export the Summa instance or options in one of:
 *   - `export const summa = createSumma({ ... })`   → we extract summa.$options
 *   - `export default createSumma({ ... })`          → we extract default.$options
 *   - `export const summa = { database: ..., ... }`  → plain SummaOptions object
 *   - `export default { database: ..., ... }`         → plain SummaOptions object
 */
export async function getConfig({
	cwd,
	configPath,
}: {
	cwd: string;
	configPath?: string;
}): Promise<ResolvedSummaConfig | null> {
	// --- Explicit --config path ---
	if (configPath) {
		let resolvedPath = resolve(cwd, configPath);
		if (existsSync(configPath)) resolvedPath = resolve(configPath);

		const result = await tryLoadConfig(resolvedPath, cwd);
		if (result) return result;

		return null;
	}

	// --- Auto-discovery ---
	for (const candidate of possibleConfigPaths) {
		const fullPath = resolve(cwd, candidate);
		if (!existsSync(fullPath)) continue;

		const result = await tryLoadConfig(fullPath, cwd);
		if (result) return result;
	}

	return null;
}

/**
 * Read tsconfig.json and extract path aliases for jiti.
 * Returns a Record<alias, resolved path> or null if no aliases found.
 */
function getPathAliases(cwd: string): Record<string, string> | null {
	const tsconfigPath = resolve(cwd, "tsconfig.json");
	if (!existsSync(tsconfigPath)) return null;

	try {
		const raw = readFileSync(tsconfigPath, "utf-8");
		// Strip comments for JSON.parse compatibility (single-line and multi-line)
		const stripped = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
		const tsconfig = JSON.parse(stripped);
		const paths = tsconfig?.compilerOptions?.paths;
		if (!paths || typeof paths !== "object") return null;

		const baseUrl = tsconfig.compilerOptions?.baseUrl ?? ".";
		const baseDir = resolve(cwd, baseUrl);
		const aliases: Record<string, string> = {};

		for (const [alias, targets] of Object.entries(paths)) {
			const target = (targets as string[])[0];
			if (!target) continue;
			// Strip trailing /* from both alias and target
			const cleanAlias = alias.replace(/\/\*$/, "");
			const cleanTarget = target.replace(/\/\*$/, "");
			aliases[cleanAlias] = resolve(baseDir, cleanTarget);
		}

		return Object.keys(aliases).length > 0 ? aliases : null;
	} catch {
		return null;
	}
}

async function tryLoadConfig(configFile: string, cwd: string): Promise<ResolvedSummaConfig | null> {
	try {
		const aliases = getPathAliases(cwd);

		// If path aliases exist, create a jiti instance with alias support
		const jitiInstance = aliases ? createJiti(cwd, { alias: aliases }) : undefined;

		const { config } = await loadConfig({
			configFile,
			cwd,
			dotenv: {
				fileName: [".env", ".env.local", ".env.development", ".env.production"],
			},
			rcFile: false,
			packageJson: false,
			globalRc: false,
			...(jitiInstance ? { jiti: jitiInstance } : {}),
		});

		if (!config || typeof config !== "object") return null;

		const options = extractOptions(config);
		if (!options) return null;

		return { options, configFile };
	} catch (error) {
		// Surface config parse errors so users can debug, instead of silently failing
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`summa: failed to load config from ${configFile}: ${message}\n`);
		return null;
	}
}

/**
 * Extract SummaOptions from the loaded module's config object.
 *
 * c12 resolves `export default X` → `{ ...X }` and named exports → `{ name: X }`.
 * We handle:
 *   1. `{ summa: Summa }` → named export `summa` (a Summa instance with $options)
 *   2. `{ summa: SummaOptions }` → named export `summa` (plain options object)
 *   3. Summa instance at root (has $options)
 *   4. Plain SummaOptions at root (has `database` key)
 */
function extractOptions(config: Record<string, unknown>): SummaOptions | null {
	// Shape 1/2: named export `summa`
	if ("summa" in config && config.summa && typeof config.summa === "object") {
		const summaExport = config.summa as Record<string, unknown>;
		// Summa instance — has $options
		if ("$options" in summaExport) {
			return summaExport.$options as SummaOptions;
		}
		// Plain options object — has `database`
		if ("database" in summaExport) {
			return summaExport as unknown as SummaOptions;
		}
	}

	// Shape 3: default export is a Summa instance
	if ("$options" in config) {
		return config.$options as SummaOptions;
	}

	// Shape 4: default export is a plain SummaOptions object
	if ("database" in config) {
		return config as unknown as SummaOptions;
	}

	return null;
}

/**
 * Find the config file path without loading it (for display purposes).
 */
export function findConfigFile(cwd: string, configPath?: string): string | null {
	if (configPath) {
		const resolved = existsSync(configPath) ? resolve(configPath) : resolve(cwd, configPath);
		return existsSync(resolved) ? resolved : null;
	}

	for (const candidate of possibleConfigPaths) {
		const fullPath = resolve(cwd, candidate);
		if (existsSync(fullPath)) return fullPath;
	}

	return null;
}
