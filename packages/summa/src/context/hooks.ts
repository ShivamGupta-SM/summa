// =============================================================================
// PLUGIN HOOKS RUNNER
// =============================================================================
// Iterates registered plugins and invokes matching lifecycle hooks.
// Before-hooks propagate errors (abort the operation).
// After-hooks catch and log errors (never rollback the operation).

import type {
	AccountHookParams,
	HoldCommitHookParams,
	HoldHookParams,
	SummaContext,
	TransactionHookParams,
} from "@summa/core";

export async function runBeforeTransactionHooks(
	ctx: SummaContext,
	params: TransactionHookParams,
): Promise<void> {
	for (const plugin of ctx.plugins) {
		if (plugin.hooks?.beforeTransaction) {
			await plugin.hooks.beforeTransaction(params);
		}
	}
}

export async function runAfterTransactionHooks(
	ctx: SummaContext,
	params: TransactionHookParams,
): Promise<void> {
	for (const plugin of ctx.plugins) {
		if (plugin.hooks?.afterTransaction) {
			try {
				await plugin.hooks.afterTransaction(params);
			} catch (err) {
				ctx.logger.error(`Plugin "${plugin.id}" afterTransaction hook failed`, {
					error: String(err),
				});
			}
		}
	}
}

export async function runBeforeAccountCreateHooks(
	ctx: SummaContext,
	params: AccountHookParams,
): Promise<void> {
	for (const plugin of ctx.plugins) {
		if (plugin.hooks?.beforeAccountCreate) {
			await plugin.hooks.beforeAccountCreate(params);
		}
	}
}

export async function runAfterAccountCreateHooks(
	ctx: SummaContext,
	params: AccountHookParams,
): Promise<void> {
	for (const plugin of ctx.plugins) {
		if (plugin.hooks?.afterAccountCreate) {
			try {
				await plugin.hooks.afterAccountCreate(params);
			} catch (err) {
				ctx.logger.error(`Plugin "${plugin.id}" afterAccountCreate hook failed`, {
					error: String(err),
				});
			}
		}
	}
}

export async function runBeforeHoldCreateHooks(
	ctx: SummaContext,
	params: HoldHookParams,
): Promise<void> {
	for (const plugin of ctx.plugins) {
		if (plugin.hooks?.beforeHoldCreate) {
			await plugin.hooks.beforeHoldCreate(params);
		}
	}
}

export async function runAfterHoldCommitHooks(
	ctx: SummaContext,
	params: HoldCommitHookParams,
): Promise<void> {
	for (const plugin of ctx.plugins) {
		if (plugin.hooks?.afterHoldCommit) {
			try {
				await plugin.hooks.afterHoldCommit(params);
			} catch (err) {
				ctx.logger.error(`Plugin "${plugin.id}" afterHoldCommit hook failed`, {
					error: String(err),
				});
			}
		}
	}
}
