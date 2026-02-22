import type { Summa } from "@summa-ledger/summa";

/**
 * Assert that the fundamental double-entry invariant holds:
 * the sum of ALL account balances (user + system) must equal zero.
 *
 * In double-entry bookkeeping, every credit to a user account has a
 * corresponding debit on a system account (and vice versa), so the
 * grand total across all accounts must always be zero.
 */
export async function assertDoubleEntryBalance(summa: Summa): Promise<void> {
	const ctx = await summa.$context;

	// Sum user account balances
	const userRows = await ctx.adapter.raw<{ total: number }>(
		`SELECT COALESCE(SUM(balance), 0)::bigint AS total FROM account_balance`,
		[],
	);
	const userTotal = Number(userRows[0]?.total ?? 0);

	// Sum system account balances (including pending hot account entries)
	const systemRows = await ctx.adapter.raw<{ total: number }>(
		`SELECT COALESCE(SUM(balance), 0)::bigint AS total FROM system_account`,
		[],
	);
	const systemTotal = Number(systemRows[0]?.total ?? 0);

	// Pending hot account entries not yet flushed to system_account
	const hotRows = await ctx.adapter.raw<{ total: number }>(
		`SELECT COALESCE(SUM(amount), 0)::bigint AS total
		 FROM hot_account_entry
		 WHERE status = 'pending'`,
		[],
	);
	const pendingHotTotal = Number(hotRows[0]?.total ?? 0);

	const grandTotal = userTotal + systemTotal + pendingHotTotal;

	if (grandTotal !== 0) {
		throw new Error(
			`Double-entry invariant violated: user(${userTotal}) + system(${systemTotal}) + pendingHot(${pendingHotTotal}) = ${grandTotal}, expected 0`,
		);
	}
}

/**
 * Assert that a specific account has the expected balance.
 */
export async function assertAccountBalance(
	summa: Summa,
	holderId: string,
	expectedBalance: number,
): Promise<void> {
	const balance = await summa.accounts.getBalance(holderId);
	if (balance.balance !== expectedBalance) {
		throw new Error(
			`Account ${holderId}: expected balance ${expectedBalance}, got ${balance.balance}`,
		);
	}
}

/**
 * Assert that the hash chain for a given aggregate is valid.
 * The hash chain ensures that no event has been tampered with or deleted.
 */
export async function assertHashChainValid(
	summa: Summa,
	aggregateType: string,
	aggregateId: string,
): Promise<void> {
	const result = await summa.events.verifyChain(aggregateType, aggregateId);
	if (!result.valid) {
		throw new Error(
			`Hash chain broken at version ${result.brokenAtVersion} for ${aggregateType}:${aggregateId}`,
		);
	}
}
