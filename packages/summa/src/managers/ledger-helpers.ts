// =============================================================================
// LEDGER HELPERS
// =============================================================================
// Utility for extracting ledgerId from context.

import type { SummaContext } from "@summa/core";
import { SummaError } from "@summa/core";

/**
 * Extract the ledger ID from context. Tries:
 * 1. ctx.requestContext.ledgerId (per-request)
 * 2. ctx.ledgerId (resolved at context creation)
 *
 * Throws INVALID_ARGUMENT if no ledgerId is found.
 */
export function getLedgerId(ctx: SummaContext): string {
	const ledgerId = ctx.requestContext?.ledgerId ?? ctx.ledgerId;
	if (!ledgerId) {
		throw SummaError.invalidArgument(
			"ledgerId is required. Pass it in the request body or X-Ledger-Id header.",
		);
	}
	return ledgerId;
}
