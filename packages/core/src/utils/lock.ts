/** Deterministic 32-bit hash for pg_advisory_xact_lock key */
export function hashLockKey(input: string): number {
	let hash = 0;
	for (let i = 0; i < input.length; i++) {
		const char = input.charCodeAt(i);
		hash = ((hash << 5) - hash + char) | 0;
	}
	return hash;
}
