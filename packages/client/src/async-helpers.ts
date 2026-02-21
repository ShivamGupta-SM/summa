// =============================================================================
// ASYNC HELPERS — Shared utilities for framework integrations
// =============================================================================

/** Normalize an unknown error into an Error instance. */
export function normalizeError(err: unknown): Error {
	return err instanceof Error ? err : new Error(String(err));
}
