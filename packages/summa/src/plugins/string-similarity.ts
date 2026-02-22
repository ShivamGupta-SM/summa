// =============================================================================
// STRING SIMILARITY ALGORITHMS
// =============================================================================
// Pure TypeScript implementations for fuzzy matching in bank reconciliation.
// No external dependencies.

/**
 * Computes the Levenshtein edit distance between two strings.
 * Returns the minimum number of single-character edits (insertions,
 * deletions, substitutions) required to change `a` into `b`.
 */
export function levenshtein(a: string, b: string): number {
	const la = a.length;
	const lb = b.length;

	if (la === 0) return lb;
	if (lb === 0) return la;

	// Use single-row optimization (O(min(la, lb)) space)
	// Arrays are always accessed within bounds [0..lb], so index access is safe.
	const at = (arr: number[], i: number): number => arr[i] as number;

	let prev = Array.from({ length: lb + 1 }, (_, j) => j);
	let curr = new Array<number>(lb + 1).fill(0);

	for (let i = 1; i <= la; i++) {
		curr[0] = i;
		for (let j = 1; j <= lb; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			curr[j] = Math.min(
				at(prev, j) + 1, // deletion
				at(curr, j - 1) + 1, // insertion
				at(prev, j - 1) + cost, // substitution
			);
		}
		[prev, curr] = [curr, prev];
	}

	return at(prev, lb);
}

/**
 * Normalized Levenshtein similarity (0–1).
 * Returns 1.0 for identical strings, 0.0 for completely different strings.
 */
export function normalizedLevenshtein(a: string, b: string): number {
	const maxLen = Math.max(a.length, b.length);
	if (maxLen === 0) return 1.0;
	return 1.0 - levenshtein(a, b) / maxLen;
}

/**
 * Jaro similarity between two strings (0–1).
 * Considers character matches and transpositions within a window.
 */
export function jaro(a: string, b: string): number {
	if (a === b) return 1.0;
	const la = a.length;
	const lb = b.length;
	if (la === 0 || lb === 0) return 0.0;

	const matchWindow = Math.max(0, Math.floor(Math.max(la, lb) / 2) - 1);

	const aMatched = new Array<boolean>(la).fill(false);
	const bMatched = new Array<boolean>(lb).fill(false);

	let matches = 0;
	let transpositions = 0;

	// Find matches
	for (let i = 0; i < la; i++) {
		const lo = Math.max(0, i - matchWindow);
		const hi = Math.min(lb - 1, i + matchWindow);
		for (let j = lo; j <= hi; j++) {
			if (bMatched[j] || a[i] !== b[j]) continue;
			aMatched[i] = true;
			bMatched[j] = true;
			matches++;
			break;
		}
	}

	if (matches === 0) return 0.0;

	// Count transpositions
	let k = 0;
	for (let i = 0; i < la; i++) {
		if (!aMatched[i]) continue;
		while (!bMatched[k]) k++;
		if (a[i] !== b[k]) transpositions++;
		k++;
	}

	return (matches / la + matches / lb + (matches - transpositions / 2) / matches) / 3;
}

/**
 * Jaro-Winkler similarity (0–1).
 * Extends Jaro with a bonus for common prefixes (up to 4 characters).
 * Better for short strings like reference numbers and names.
 */
export function jaroWinkler(a: string, b: string, prefixScale = 0.1): number {
	const jaroSim = jaro(a, b);

	// Common prefix length (max 4)
	let prefix = 0;
	const maxPrefix = Math.min(4, Math.min(a.length, b.length));
	for (let i = 0; i < maxPrefix; i++) {
		if (a[i] !== b[i]) break;
		prefix++;
	}

	return jaroSim + prefix * prefixScale * (1 - jaroSim);
}
