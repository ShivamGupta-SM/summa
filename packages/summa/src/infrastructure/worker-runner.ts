// =============================================================================
// WORKER RUNNER -- Background worker infrastructure for Summa plugins
// =============================================================================
// Collects SummaWorkerDefinition entries from all registered plugins and runs
// them on a polling loop.  Supports distributed leasing so that only one
// process in a cluster executes lease-required workers at a time.

import { randomUUID } from "node:crypto";
import type { SummaContext, SummaWorkerDefinition } from "@summa/core";

// =============================================================================
// INTERVAL PARSING
// =============================================================================

const INTERVAL_UNITS: Record<string, number> = {
	s: 1_000,
	m: 60_000,
	h: 3_600_000,
	d: 86_400_000,
};

/**
 * Parse a human-friendly interval string into milliseconds.
 *
 * Supported formats: "5s", "1m", "30m", "1h", "1d"
 */
export function parseInterval(interval: string): number {
	const match = interval.match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/);
	if (!match) {
		throw new Error(
			`Invalid interval "${interval}". Expected format: <number><s|m|h|d> (e.g. "5s", "1m", "1h", "1d")`,
		);
	}

	const value = Number(match[1]);
	const unit = match[2] as keyof typeof INTERVAL_UNITS;

	if (value <= 0) {
		throw new Error(`Interval value must be positive, got ${value}`);
	}

	return value * INTERVAL_UNITS[unit]!;
}

// =============================================================================
// JITTER
// =============================================================================

/** Apply ±25% jitter to an interval to prevent thundering herd. */
function withJitter(ms: number): number {
	const jitterFactor = 0.75 + Math.random() * 0.5; // [0.75, 1.25]
	return Math.round(ms * jitterFactor);
}

// =============================================================================
// WORKER RUNNER CLASS
// =============================================================================

interface RunningWorker {
	definition: SummaWorkerDefinition;
	intervalMs: number;
	timer: ReturnType<typeof setTimeout> | null;
	running: boolean;
}

export class SummaWorkerRunner {
	private readonly ctx: SummaContext;
	private readonly leaseHolder: string;
	private readonly workers: RunningWorker[] = [];
	private started = false;
	private stopped = false;

	constructor(ctx: SummaContext) {
		this.ctx = ctx;
		this.leaseHolder = randomUUID();
	}

	// ---------------------------------------------------------------------------
	// START
	// ---------------------------------------------------------------------------

	start(): void {
		if (this.started) {
			throw new Error("SummaWorkerRunner is already started");
		}
		this.started = true;

		// Collect worker definitions from all plugins
		const definitions: SummaWorkerDefinition[] = [];
		for (const plugin of this.ctx.plugins) {
			if (plugin.workers) {
				for (const worker of plugin.workers) {
					definitions.push(worker);
				}
			}
		}

		if (definitions.length === 0) {
			this.ctx.logger.info("No plugin workers registered");
			return;
		}

		this.ctx.logger.info("Starting worker runner", {
			workerCount: definitions.length,
			leaseHolder: this.leaseHolder,
			workers: definitions.map((w) => w.id),
		});

		for (const definition of definitions) {
			const intervalMs = parseInterval(definition.interval);
			const runningWorker: RunningWorker = {
				definition,
				intervalMs,
				timer: null,
				running: false,
			};
			this.workers.push(runningWorker);
			this.scheduleNext(runningWorker);
		}
	}

	// ---------------------------------------------------------------------------
	// STOP
	// ---------------------------------------------------------------------------

	async stop(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;

		this.ctx.logger.info("Stopping worker runner", {
			leaseHolder: this.leaseHolder,
		});

		// Clear all pending timers
		for (const worker of this.workers) {
			if (worker.timer !== null) {
				clearTimeout(worker.timer);
				worker.timer = null;
			}
		}

		// Wait for currently running workers to finish (with timeout)
		const SHUTDOWN_TIMEOUT_MS = 10_000;
		const runningWorkers = this.workers.filter((w) => w.running);
		if (runningWorkers.length > 0) {
			this.ctx.logger.info("Waiting for running workers to finish", {
				count: runningWorkers.length,
				workers: runningWorkers.map((w) => w.definition.id),
			});

			await Promise.race([
				Promise.all(
					runningWorkers.map(
						(w) =>
							new Promise<void>((resolve) => {
								const check = () => {
									if (!w.running) return resolve();
									setTimeout(check, 50);
								};
								check();
							}),
					),
				),
				new Promise<void>((resolve) => {
					setTimeout(() => {
						this.ctx.logger.warn("Worker shutdown timed out, proceeding", {
							stillRunning: runningWorkers.filter((w) => w.running).map((w) => w.definition.id),
						});
						resolve();
					}, SHUTDOWN_TIMEOUT_MS);
				}),
			]);
		}

		// Release any held leases
		await this.releaseAllLeases();
	}

	// ---------------------------------------------------------------------------
	// SCHEDULING
	// ---------------------------------------------------------------------------

	private scheduleNext(worker: RunningWorker): void {
		if (this.stopped) return;

		const delay = withJitter(worker.intervalMs);
		worker.timer = setTimeout(() => {
			void this.executeWorker(worker);
		}, delay);
	}

	// ---------------------------------------------------------------------------
	// EXECUTION
	// ---------------------------------------------------------------------------

	private async executeWorker(worker: RunningWorker): Promise<void> {
		if (this.stopped || worker.running) return;

		worker.running = true;
		const { definition } = worker;

		try {
			if (definition.leaseRequired) {
				const acquired = await this.acquireLease(definition.id, worker.intervalMs);
				if (!acquired) {
					this.ctx.logger.info("Worker lease not acquired, skipping", {
						workerId: definition.id,
					});
					return;
				}
			}

			await definition.handler(this.ctx);
		} catch (error) {
			this.ctx.logger.error("Worker execution failed", {
				workerId: definition.id,
				error: error instanceof Error ? error.message : String(error),
			});
		} finally {
			worker.running = false;
			this.scheduleNext(worker);
		}
	}

	// ---------------------------------------------------------------------------
	// LEASE MANAGEMENT
	// ---------------------------------------------------------------------------

	/**
	 * Attempt to acquire a distributed lease for a worker.
	 *
	 * Uses an INSERT ... ON CONFLICT with a lease_until expiry check so that
	 * only one process wins the lease.  Lease duration is 2x the worker
	 * interval so it expires naturally if the owning process dies.
	 */
	private async acquireLease(workerId: string, intervalMs: number): Promise<boolean> {
		const leaseDurationMs = intervalMs * 2;
		const leaseUntil = new Date(Date.now() + leaseDurationMs).toISOString();

		try {
			const d = this.ctx.dialect;
			const rows = await this.ctx.adapter.raw<{ worker_id: string }>(
				`INSERT INTO worker_lease (worker_id, lease_holder, lease_until)
				 VALUES ($1, $2, $3)
				 ${d.onConflictDoUpdate(["worker_id"], { lease_holder: "$2", lease_until: "$3" })}
				 WHERE worker_lease.lease_until < ${d.now()}
				 ${d.returning(["*"])}`,
				[workerId, this.leaseHolder, leaseUntil],
			);

			return rows.length > 0;
		} catch (error) {
			this.ctx.logger.error("Failed to acquire worker lease", {
				workerId,
				error: error instanceof Error ? error.message : String(error),
			});
			return false;
		}
	}

	/** Release all leases held by this runner instance. */
	private async releaseAllLeases(): Promise<void> {
		try {
			await this.ctx.adapter.rawMutate(`DELETE FROM worker_lease WHERE lease_holder = $1`, [
				this.leaseHolder,
			]);
		} catch (error) {
			this.ctx.logger.error("Failed to release worker leases", {
				leaseHolder: this.leaseHolder,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
}

// =============================================================================
// FACTORY
// =============================================================================

export function createWorkerRunner(ctx: SummaContext): SummaWorkerRunner {
	return new SummaWorkerRunner(ctx);
}
