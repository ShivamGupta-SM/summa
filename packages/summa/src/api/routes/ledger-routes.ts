// =============================================================================
// LEDGER & HEALTH ROUTES
// =============================================================================

import { createTableResolver } from "@summa/core/db";
import type { Summa } from "../../summa/base.js";
import type { Route } from "../handler.js";
import { defineRoute, json } from "../handler.js";
import { validateBody } from "../validation.js";

export const ledgerRoutes: Route[] = [
	defineRoute("GET", "/ok", async () => {
		return json(200, { ok: true });
	}),

	defineRoute("POST", "/ledgers", async (req, summa) => {
		const err = validateBody(req.body, { name: "string", metadata: "object?" });
		if (err) return json(400, { error: { code: "INVALID_ARGUMENT", message: err.error } });
		const result = await summa.ledgers.create(
			req.body as Parameters<Summa["ledgers"]["create"]>[0],
		);
		return json(201, result);
	}),

	defineRoute("GET", "/ledgers", async (_req, summa) => {
		const result = await summa.ledgers.list();
		return json(200, result);
	}),

	defineRoute("GET", "/ledgers/:id", async (_req, summa, params) => {
		const result = await summa.ledgers.get(params.id ?? "");
		return json(200, result);
	}),

	defineRoute("GET", "/health", async (_req, summa) => {
		const ctx = await summa.$context;
		const t = createTableResolver(ctx.options.schema);
		const checks: Record<string, unknown> = {};
		let healthy = true;

		try {
			await ctx.adapter.raw<{ ok: number }>("SELECT 1 AS ok", []);
			checks.database = { status: "ok" };
		} catch (err) {
			checks.database = { status: "error", message: String(err) };
			healthy = false;
		}

		try {
			const rows = await ctx.adapter.raw<{ cnt: string }>(
				`SELECT COUNT(*) as cnt FROM ${t("worker_lease")}`,
				[],
			);
			checks.schema = { status: "ok", workerLeases: Number(rows[0]?.cnt ?? 0) };
		} catch (err) {
			checks.schema = { status: "error", message: String(err) };
			healthy = false;
		}

		return json(healthy ? 200 : 503, {
			status: healthy ? "healthy" : "degraded",
			checks,
			timestamp: new Date().toISOString(),
		});
	}),
];
