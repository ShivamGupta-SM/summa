// =============================================================================
// PII REDACTION — Shared helper for log data redaction
// =============================================================================

const DEFAULT_REDACT_KEYS = new Set(["email", "phone", "ssn", "password", "token", "secret"]);

/**
 * Shallow-redact keys from a log data object.
 * Keys matching the redact set have their values replaced with "[REDACTED]".
 */
export function redactData(
	data: Record<string, unknown> | undefined,
	keys: Set<string>,
): Record<string, unknown> | undefined {
	if (!data || keys.size === 0) return data;

	let redacted: Record<string, unknown> | undefined;
	for (const key of Object.keys(data)) {
		if (keys.has(key)) {
			if (!redacted) redacted = { ...data };
			redacted[key] = "[REDACTED]";
		}
	}
	return redacted ?? data;
}

/**
 * Build the redaction key set from user-provided keys (or defaults).
 */
export function buildRedactKeys(userKeys?: string[]): Set<string> {
	if (userKeys) return new Set(userKeys);
	return new Set(DEFAULT_REDACT_KEYS);
}
