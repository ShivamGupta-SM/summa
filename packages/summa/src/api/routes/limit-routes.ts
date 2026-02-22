// =============================================================================
// LIMIT ROUTES
// =============================================================================

import type { LimitType } from "@summa-ledger/core";
import type { Summa } from "../../summa/base.js";
import type { Route } from "../handler.js";
import { defineRoute, json } from "../handler.js";
import { VALID_LIMIT_TYPES, VALID_TXN_TYPES, validateBody, validateEnum } from "../validation.js";

export const limitRoutes: Route[] = [
	defineRoute("POST", "/limits", async (req, summa) => {
		const err = validateBody(req.body, {
			holderId: "string",
			limitType: "string",
			maxAmount: "number",
		});
		if (err) return json(400, { error: { code: "INVALID_ARGUMENT", message: err.error } });
		const { limitType } = req.body as { limitType: string };
		if (!VALID_LIMIT_TYPES.has(limitType)) {
			return json(400, {
				error: {
					code: "INVALID_ARGUMENT",
					message: `Invalid limitType: "${limitType}". Must be one of: ${[...VALID_LIMIT_TYPES].join(", ")}`,
				},
			});
		}
		const result = await summa.limits.set(req.body as Parameters<Summa["limits"]["set"]>[0]);
		return json(201, result);
	}),

	defineRoute("GET", "/limits/:holderId/usage", async (req, summa, params) => {
		const txnTypeErr = validateEnum(req.query.txnType, VALID_TXN_TYPES, "txnType");
		if (txnTypeErr) return txnTypeErr;
		const result = await summa.limits.getUsage({
			holderId: params.holderId ?? "",
			txnType: req.query.txnType as "credit" | "debit" | "hold" | undefined,
			category: req.query.category,
		});
		return json(200, result);
	}),

	defineRoute("GET", "/limits/:holderId", async (_req, summa, params) => {
		const result = await summa.limits.get(params.holderId ?? "");
		return json(200, result);
	}),

	defineRoute("DELETE", "/limits/:holderId", async (req, summa, params) => {
		const err = validateBody(req.body, { limitType: "string", category: "string?" });
		if (err) return json(400, { error: { code: "INVALID_ARGUMENT", message: err.error } });
		const body = req.body as { limitType: LimitType; category?: string };
		await summa.limits.remove({
			...body,
			holderId: params.holderId ?? "",
		});
		return json(204, null);
	}),
];
