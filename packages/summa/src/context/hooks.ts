// =============================================================================
// PLUGIN HOOKS RUNNER
// =============================================================================
// Iterates registered plugins and invokes matching lifecycle hooks.
// Before-hooks propagate errors (abort the operation).
// After-hooks catch and log errors (never rollback the operation).
//
// Performance: Hook presence is pre-computed via buildHookCache() at context
// creation time, so hook runners only iterate plugins that actually define
// the relevant hook. After-hooks run in parallel (errors are independent).

import type {
	AccountHookParams,
	HoldCommitHookParams,
	HoldHookParams,
	SummaContext,
	SummaOperation,
	SummaPlugin,
	TransactionHookParams,
} from "@summa-ledger/core";

// =============================================================================
// HOOK CACHE — Pre-computed at context creation
// =============================================================================

export interface HookCache {
	beforeTransaction: SummaPlugin[];
	afterTransaction: SummaPlugin[];
	beforeAccountCreate: SummaPlugin[];
	afterAccountCreate: SummaPlugin[];
	beforeHoldCreate: SummaPlugin[];
	afterHoldCommit: SummaPlugin[];
	beforeOperation: SummaPlugin[];
	afterOperation: SummaPlugin[];
}

/** Build a hook cache from the plugin list. Call once at context creation. */
export function buildHookCache(plugins: SummaPlugin[]): HookCache {
	return {
		beforeTransaction: plugins.filter((p) => p.hooks?.beforeTransaction),
		afterTransaction: plugins.filter((p) => p.hooks?.afterTransaction),
		beforeAccountCreate: plugins.filter((p) => p.hooks?.beforeAccountCreate),
		afterAccountCreate: plugins.filter((p) => p.hooks?.afterAccountCreate),
		beforeHoldCreate: plugins.filter((p) => p.hooks?.beforeHoldCreate),
		afterHoldCommit: plugins.filter((p) => p.hooks?.afterHoldCommit),
		beforeOperation: plugins.filter((p) => p.operationHooks?.before?.length),
		afterOperation: plugins.filter((p) => p.operationHooks?.after?.length),
	};
}

// =============================================================================
// BEFORE HOOKS — Sequential, errors propagate (abort the operation)
// =============================================================================

export async function runBeforeTransactionHooks(
	ctx: SummaContext,
	params: TransactionHookParams,
): Promise<void> {
	const plugins = ctx._hookCache?.beforeTransaction ?? ctx.plugins;
	for (const plugin of plugins) {
		if (plugin.hooks?.beforeTransaction) {
			await plugin.hooks.beforeTransaction(params);
		}
	}
}

export async function runBeforeAccountCreateHooks(
	ctx: SummaContext,
	params: AccountHookParams,
): Promise<void> {
	const plugins = ctx._hookCache?.beforeAccountCreate ?? ctx.plugins;
	for (const plugin of plugins) {
		if (plugin.hooks?.beforeAccountCreate) {
			await plugin.hooks.beforeAccountCreate(params);
		}
	}
}

export async function runBeforeHoldCreateHooks(
	ctx: SummaContext,
	params: HoldHookParams,
): Promise<void> {
	const plugins = ctx._hookCache?.beforeHoldCreate ?? ctx.plugins;
	for (const plugin of plugins) {
		if (plugin.hooks?.beforeHoldCreate) {
			await plugin.hooks.beforeHoldCreate(params);
		}
	}
}

// =============================================================================
// AFTER HOOKS — Parallel, errors caught and logged (never rollback)
// =============================================================================

export async function runAfterTransactionHooks(
	ctx: SummaContext,
	params: TransactionHookParams,
): Promise<void> {
	const plugins = ctx._hookCache?.afterTransaction ?? ctx.plugins;
	if (plugins.length === 0) return;
	await Promise.all(
		plugins.map((plugin) => {
			const hook = plugin.hooks?.afterTransaction;
			if (!hook) return Promise.resolve();
			return hook(params).catch((err) => {
				ctx.logger.error(`Plugin "${plugin.id}" afterTransaction hook failed`, {
					error: String(err),
				});
			});
		}),
	);
}

export async function runAfterAccountCreateHooks(
	ctx: SummaContext,
	params: AccountHookParams,
): Promise<void> {
	const plugins = ctx._hookCache?.afterAccountCreate ?? ctx.plugins;
	if (plugins.length === 0) return;
	await Promise.all(
		plugins.map((plugin) => {
			const hook = plugin.hooks?.afterAccountCreate;
			if (!hook) return Promise.resolve();
			return hook(params).catch((err) => {
				ctx.logger.error(`Plugin "${plugin.id}" afterAccountCreate hook failed`, {
					error: String(err),
				});
			});
		}),
	);
}

export async function runAfterHoldCommitHooks(
	ctx: SummaContext,
	params: HoldCommitHookParams,
): Promise<void> {
	const plugins = ctx._hookCache?.afterHoldCommit ?? ctx.plugins;
	if (plugins.length === 0) return;
	await Promise.all(
		plugins.map((plugin) => {
			const hook = plugin.hooks?.afterHoldCommit;
			if (!hook) return Promise.resolve();
			return hook(params).catch((err) => {
				ctx.logger.error(`Plugin "${plugin.id}" afterHoldCommit hook failed`, {
					error: String(err),
				});
			});
		}),
	);
}

// =============================================================================
// OPERATION HOOKS (matcher-based, used by audit-log and other plugins)
// =============================================================================

/**
 * Run before-operation hooks. Returns `{ cancelled: true, reason }` if any
 * plugin cancels the operation, otherwise `{ cancelled: false }`.
 */
export async function runBeforeOperationHooks(
	ctx: SummaContext,
	operation: SummaOperation,
): Promise<{ cancelled: boolean; reason?: string }> {
	const plugins = ctx._hookCache?.beforeOperation ?? ctx.plugins;
	for (const plugin of plugins) {
		if (!plugin.operationHooks?.before) continue;
		for (const hook of plugin.operationHooks.before) {
			if (!hook.matcher(operation)) continue;
			const result = await hook.handler({
				operation,
				context: ctx,
				requestContext: ctx.requestContext,
			});
			if (result?.cancel) {
				return { cancelled: true, reason: result.reason };
			}
		}
	}
	return { cancelled: false };
}

/**
 * Run after-operation hooks. Errors are caught and logged per-plugin
 * (never rollback the completed operation). Runs in parallel.
 */
export async function runAfterOperationHooks(
	ctx: SummaContext,
	operation: SummaOperation,
): Promise<void> {
	const plugins = ctx._hookCache?.afterOperation ?? ctx.plugins;
	if (plugins.length === 0) return;

	const promises: Promise<void>[] = [];
	for (const plugin of plugins) {
		if (!plugin.operationHooks?.after) continue;
		for (const hook of plugin.operationHooks.after) {
			if (!hook.matcher(operation)) continue;
			promises.push(
				hook
					.handler({ operation, context: ctx, requestContext: ctx.requestContext })
					.catch((err) => {
						ctx.logger.error(`Plugin "${plugin.id}" operationHooks.after failed`, {
							error: String(err),
							operation: operation.type,
						});
					}),
			);
		}
	}
	if (promises.length > 0) await Promise.all(promises);
}
