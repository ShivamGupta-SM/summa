// =============================================================================
// EVENT ROUTES
// =============================================================================

import type { Route } from "../handler.js";
import { defineRoute, json } from "../handler.js";
import { validateBody } from "../validation.js";

export const eventRoutes: Route[] = [
	// Specific path before parametric
	defineRoute("GET", "/events/correlation/:correlationId", async (_req, summa, params) => {
		const result = await summa.events.getByCorrelation(params.correlationId ?? "");
		return json(200, result);
	}),

	defineRoute("POST", "/events/verify", async (req, summa) => {
		const err = validateBody(req.body, { aggregateType: "string", aggregateId: "string" });
		if (err) return json(400, { error: { code: "INVALID_ARGUMENT", message: err.error } });
		const body = req.body as { aggregateType: string; aggregateId: string };
		const result = await summa.events.verifyChain(body.aggregateType, body.aggregateId);
		return json(200, result);
	}),

	defineRoute("GET", "/events/:aggregateType/:aggregateId", async (_req, summa, params) => {
		const result = await summa.events.getForAggregate(
			params.aggregateType ?? "",
			params.aggregateId ?? "",
		);
		return json(200, result);
	}),
];
