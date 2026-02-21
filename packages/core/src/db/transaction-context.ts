// =============================================================================
// TRANSACTION CONTEXT — AsyncLocalStorage-based post-commit callback queue
// =============================================================================
// Allows code running inside a transaction to register callbacks that execute
// AFTER the transaction commits successfully. Useful for side effects like
// sending notifications, updating caches, or publishing events.

import { AsyncLocalStorage } from "node:async_hooks";

type AfterCommitCallback = () => void | Promise<void>;

interface TransactionStore {
	callbacks: AfterCommitCallback[];
}

const storage = new AsyncLocalStorage<TransactionStore>();

/**
 * Queue a callback to run after the current transaction commits.
 * If called outside a transaction context, the callback is ignored.
 *
 * @example
 * ```ts
 * import { queueAfterTransactionHook } from "@summa/core/db";
 *
 * // Inside a plugin hook or adapter operation:
 * queueAfterTransactionHook(() => {
 *   console.log("Transaction committed, sending notification...");
 * });
 * ```
 */
export function queueAfterTransactionHook(cb: AfterCommitCallback): void {
	const store = storage.getStore();
	if (store) {
		store.callbacks.push(cb);
	}
}

/**
 * Run `fn` within a transaction context, then drain all queued callbacks
 * after `fn` resolves successfully. If `fn` throws, callbacks are discarded.
 *
 * This should wrap the adapter's `transaction()` call in the event store.
 *
 * @param onCallbackError - Optional handler invoked when an after-commit
 *   callback throws. Receives the error and the callback index. If not
 *   provided, failures are logged to stderr as a fallback.
 */
export async function runWithTransactionContext<T>(
	fn: () => Promise<T>,
	onCallbackError?: (error: unknown, index: number) => void,
): Promise<T> {
	const store: TransactionStore = { callbacks: [] };

	const result = await storage.run(store, fn);

	// Drain callbacks after successful commit
	for (let i = 0; i < store.callbacks.length; i++) {
		try {
			const cb = store.callbacks[i];
			if (cb) await cb();
		} catch (error) {
			if (onCallbackError) {
				onCallbackError(error, i);
			} else {
				// Fallback: log to stderr so failures are never fully silent
				console.error("[summa] after-commit callback failed", error);
			}
		}
	}

	return result;
}
