// =============================================================================
// BALANCE CHECK -- Shared overdraft-aware balance validation
// =============================================================================
// Single source of truth for all balance checks across debit, transfer,
// multi-transfer, hold, and batch operations.

import { SummaError } from "@summa-ledger/core";

/**
 * Check whether an account has sufficient balance for a debit of `amount`.
 *
 * Rules:
 * 1. If `allowOverdraft` is false → available must be >= amount.
 * 2. If `allowOverdraft` is true and `overdraftLimit` > 0 → available - amount must not go below -overdraftLimit.
 * 3. If `allowOverdraft` is true and `overdraftLimit` is 0 → unlimited overdraft (no check).
 *
 * @throws SummaError.insufficientBalance with standardized message including available/required amounts.
 */
export function checkSufficientBalance(params: {
	available: number;
	amount: number;
	allowOverdraft: boolean;
	overdraftLimit: number;
}): void {
	const { available, amount, allowOverdraft, overdraftLimit } = params;

	if (!allowOverdraft) {
		if (available < amount) {
			throw SummaError.insufficientBalance(
				`Insufficient balance. Available: ${available}, Required: ${amount}`,
			);
		}
		return;
	}

	// Overdraft enabled with a finite limit
	if (overdraftLimit > 0 && available - amount < -overdraftLimit) {
		throw SummaError.insufficientBalance(
			`Transaction would exceed overdraft limit. Available (incl. overdraft): ${available + overdraftLimit}, Required: ${amount}`,
		);
	}
}
