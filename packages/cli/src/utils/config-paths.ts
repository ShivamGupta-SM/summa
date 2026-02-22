// =============================================================================
// Config file discovery paths
// =============================================================================
// Defines all candidate file paths the CLI probes when searching for the
// user's summa config. Mirrors the better-auth approach: multiply base
// filenames by common directory prefixes.

const baseNames = ["summa.config", "summa", "ledger"];

const extensions = [".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs"];

const directoryPrefixes = [
	"", // project root
	"lib/",
	"server/",
	"config/",
	"src/",
	"src/lib/",
	"src/server/",
	"src/config/",
	"app/",
	"app/lib/",
	"app/server/",
];

export const possibleConfigPaths: string[] = [];

for (const dir of directoryPrefixes) {
	for (const base of baseNames) {
		for (const ext of extensions) {
			possibleConfigPaths.push(`${dir}${base}${ext}`);
		}
	}
}
