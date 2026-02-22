// =============================================================================
// HOLD ROUTES
// =============================================================================

import type { Summa } from "../../summa/base.js";
import type { Route } from "../handler.js";
import { defineRoute, json } from "../handler.js";
import {
	VALID_HOLD_STATUSES,
	VALIDATION_SCHEMAS,
	validateBody,
	validateEnum,
	validatePositiveIntegerAmount,
} from "../validation.js";

export const holdRoutes: Route[] = [
	// Specific paths before parametric
	defineRoute("GET", "/holds/active", async (req, summa) => {
		const result = await summa.holds.listActive({
			holderId: req.query.holderId ?? "",
			page: req.query.page ? Number(req.query.page) : undefined,
			perPage: req.query.perPage ? Number(req.query.perPage) : undefined,
			category: req.query.category,
		});
		return json(200, result);
	}),

	defineRoute("GET", "/holds", async (req, summa) => {
		const statusErr = validateEnum(req.query.status, VALID_HOLD_STATUSES, "status");
		if (statusErr) return statusErr;
		const result = await summa.holds.listAll({
			holderId: req.query.holderId ?? "",
			page: req.query.page ? Number(req.query.page) : undefined,
			perPage: req.query.perPage ? Number(req.query.perPage) : undefined,
			status: req.query.status as "inflight" | "posted" | "voided" | "expired" | undefined,
			category: req.query.category,
		});
		return json(200, result);
	}),

	defineRoute("POST", "/holds", async (req, summa) => {
		const err = validateBody(req.body, VALIDATION_SCHEMAS.hold);
		if (err) return json(400, { error: { code: "INVALID_ARGUMENT", message: err.error } });
		const amtErr = validatePositiveIntegerAmount(req.body);
		if (amtErr) return json(400, { error: { code: "INVALID_ARGUMENT", message: amtErr.error } });
		const result = await summa.holds.create(req.body as Parameters<Summa["holds"]["create"]>[0]);
		return json(201, result);
	}),

	defineRoute("POST", "/holds/multi-destination", async (req, summa) => {
		const err = validateBody(req.body, VALIDATION_SCHEMAS.holdMultiDest);
		if (err) return json(400, { error: { code: "INVALID_ARGUMENT", message: err.error } });
		const amtErr = validatePositiveIntegerAmount(req.body);
		if (amtErr) return json(400, { error: { code: "INVALID_ARGUMENT", message: amtErr.error } });
		const result = await summa.holds.createMultiDestination(
			req.body as Parameters<Summa["holds"]["createMultiDestination"]>[0],
		);
		return json(201, result);
	}),

	defineRoute("POST", "/holds/:holdId/commit", async (req, summa, params) => {
		const err = validateBody(req.body, { amount: "number?" });
		if (err) return json(400, { error: { code: "INVALID_ARGUMENT", message: err.error } });
		const body = req.body as { amount?: number };
		const result = await summa.holds.commit({ ...body, holdId: params.holdId ?? "" });
		return json(200, result);
	}),

	defineRoute("POST", "/holds/:holdId/void", async (req, summa, params) => {
		const err = validateBody(req.body, { reason: "string?" });
		if (err) return json(400, { error: { code: "INVALID_ARGUMENT", message: err.error } });
		const body = req.body as { reason?: string };
		const result = await summa.holds.void({ ...body, holdId: params.holdId ?? "" });
		return json(200, result);
	}),

	defineRoute("GET", "/holds/:id", async (_req, summa, params) => {
		const result = await summa.holds.get(params.id ?? "");
		return json(200, result);
	}),
];
