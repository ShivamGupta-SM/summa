import { createHash } from "node:crypto";
import stringify from "safe-stable-stringify";

const deterministicStringify = stringify.configure({ deterministic: true });

/**
 * Compute SHA-256 hash for an event in the chain.
 * hash = SHA256(prevHash + deterministicJSON(eventData))
 *
 * Uses deterministic (sorted-key) serialization to ensure consistency
 * after JSONB round-trips through PostgreSQL.
 */
export function computeHash(prevHash: string | null, eventData: Record<string, unknown>): string {
	// Normalize to match JSONB round-trip behavior
	const normalized = JSON.parse(JSON.stringify(eventData));
	const payload = (prevHash ?? "") + (deterministicStringify(normalized) as string);
	return createHash("sha256").update(payload).digest("hex");
}
