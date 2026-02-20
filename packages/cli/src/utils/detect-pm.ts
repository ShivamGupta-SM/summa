import { existsSync } from "node:fs";
import { join } from "node:path";

export type PackageManager = "npm" | "yarn" | "pnpm" | "bun";

/**
 * Detect which package manager is being used in the project.
 *
 * Resolution order:
 * 1. `npm_config_user_agent` env var (set by all major PMs)
 * 2. Lock file presence in `cwd`
 * 3. Fallback to npm
 */
export function detectPackageManager(cwd: string): PackageManager {
	// Strategy 1: npm_config_user_agent (e.g. "pnpm/10.6.2 node/v22.0.0 ...")
	const userAgent = process.env.npm_config_user_agent;
	if (userAgent) {
		const pmSpec = userAgent.split(" ")[0] ?? "";
		const sep = pmSpec.lastIndexOf("/");
		const name = sep > 0 ? pmSpec.substring(0, sep) : pmSpec;
		if (name === "pnpm") return "pnpm";
		if (name === "yarn") return "yarn";
		if (name === "bun") return "bun";
		if (name === "npm") return "npm";
	}

	// Strategy 2: Lock file presence
	if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
	if (existsSync(join(cwd, "yarn.lock"))) return "yarn";
	if (existsSync(join(cwd, "bun.lock")) || existsSync(join(cwd, "bun.lockb"))) return "bun";
	if (existsSync(join(cwd, "package-lock.json"))) return "npm";

	return "npm";
}

/** Get the install command for a package manager. */
export function getInstallCommand(pm: PackageManager, deps: string[]): string {
	const list = deps.join(" ");
	switch (pm) {
		case "pnpm":
			return `pnpm add ${list}`;
		case "yarn":
			return `yarn add ${list}`;
		case "bun":
			return `bun add ${list}`;
		case "npm":
			return `npm install ${list}`;
	}
}
