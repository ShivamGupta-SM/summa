// =============================================================================
// TRANSACTION ROUTES
// =============================================================================

import type { TransactionStatus, TransactionType } from "@summa-ledger/core";
import type { Summa } from "../../summa/base.js";
import type { Route } from "../handler.js";
import { defineRoute, json } from "../handler.js";
import {
	VALID_ADJUSTMENT_TYPES,
	VALID_TX_STATUSES,
	VALID_TX_TYPES,
	VALIDATION_SCHEMAS,
	validateBody,
	validateEnum,
	validatePositiveIntegerAmount,
} from "../validation.js";

export const transactionRoutes: Route[] = [
	defineRoute("GET", "/transactions", async (req, summa) => {
		const statusErr = validateEnum(req.query.status, VALID_TX_STATUSES, "status");
		if (statusErr) return statusErr;
		const typeErr = validateEnum(req.query.type, VALID_TX_TYPES, "type");
		if (typeErr) return typeErr;
		const result = await summa.transactions.list({
			holderId: req.query.holderId ?? "",
			page: req.query.page ? Number(req.query.page) : undefined,
			perPage: req.query.perPage ? Number(req.query.perPage) : undefined,
			status: req.query.status as TransactionStatus | undefined,
			category: req.query.category,
			type: req.query.type as TransactionType | undefined,
			dateFrom: req.query.dateFrom,
			dateTo: req.query.dateTo,
			amountMin: req.query.amountMin ? Number(req.query.amountMin) : undefined,
			amountMax: req.query.amountMax ? Number(req.query.amountMax) : undefined,
		});
		return json(200, result);
	}),

	defineRoute("POST", "/transactions/credit", async (req, summa) => {
		const err = validateBody(req.body, VALIDATION_SCHEMAS.credit);
		if (err) return json(400, { error: { code: "INVALID_ARGUMENT", message: err.error } });
		const amtErr = validatePositiveIntegerAmount(req.body);
		if (amtErr) return json(400, { error: { code: "INVALID_ARGUMENT", message: amtErr.error } });
		const result = await summa.transactions.credit(
			req.body as Parameters<Summa["transactions"]["credit"]>[0],
		);
		return json(201, result);
	}),

	defineRoute("POST", "/transactions/debit", async (req, summa) => {
		const err = validateBody(req.body, VALIDATION_SCHEMAS.debit);
		if (err) return json(400, { error: { code: "INVALID_ARGUMENT", message: err.error } });
		const amtErr = validatePositiveIntegerAmount(req.body);
		if (amtErr) return json(400, { error: { code: "INVALID_ARGUMENT", message: amtErr.error } });
		const result = await summa.transactions.debit(
			req.body as Parameters<Summa["transactions"]["debit"]>[0],
		);
		return json(201, result);
	}),

	defineRoute("POST", "/transactions/force-debit", async (req, summa) => {
		const err = validateBody(req.body, VALIDATION_SCHEMAS.forceDebit);
		if (err) return json(400, { error: { code: "INVALID_ARGUMENT", message: err.error } });
		const amtErr = validatePositiveIntegerAmount(req.body);
		if (amtErr) return json(400, { error: { code: "INVALID_ARGUMENT", message: amtErr.error } });
		const result = await summa.transactions.forceDebit(
			req.body as Parameters<Summa["transactions"]["forceDebit"]>[0],
		);
		return json(201, result);
	}),

	defineRoute("POST", "/transactions/transfer", async (req, summa) => {
		const err = validateBody(req.body, VALIDATION_SCHEMAS.transfer);
		if (err) return json(400, { error: { code: "INVALID_ARGUMENT", message: err.error } });
		const amtErr = validatePositiveIntegerAmount(req.body);
		if (amtErr) return json(400, { error: { code: "INVALID_ARGUMENT", message: amtErr.error } });
		const result = await summa.transactions.transfer(
			req.body as Parameters<Summa["transactions"]["transfer"]>[0],
		);
		return json(201, result);
	}),

	defineRoute("POST", "/transactions/multi-transfer", async (req, summa) => {
		const err = validateBody(req.body, VALIDATION_SCHEMAS.multiTransfer);
		if (err) return json(400, { error: { code: "INVALID_ARGUMENT", message: err.error } });
		const amtErr = validatePositiveIntegerAmount(req.body);
		if (amtErr) return json(400, { error: { code: "INVALID_ARGUMENT", message: amtErr.error } });
		const result = await summa.transactions.multiTransfer(
			req.body as Parameters<Summa["transactions"]["multiTransfer"]>[0],
		);
		return json(201, result);
	}),

	defineRoute("POST", "/transactions/refund", async (req, summa) => {
		const err = validateBody(req.body, VALIDATION_SCHEMAS.refund);
		if (err) return json(400, { error: { code: "INVALID_ARGUMENT", message: err.error } });
		const result = await summa.transactions.refund(
			req.body as Parameters<Summa["transactions"]["refund"]>[0],
		);
		return json(201, result);
	}),

	defineRoute("POST", "/transactions/correct", async (req, summa) => {
		const err = validateBody(req.body, VALIDATION_SCHEMAS.correct);
		if (err) return json(400, { error: { code: "INVALID_ARGUMENT", message: err.error } });
		const result = await summa.transactions.correct(
			req.body as Parameters<Summa["transactions"]["correct"]>[0],
		);
		return json(201, result);
	}),

	defineRoute("POST", "/transactions/adjust", async (req, summa) => {
		const err = validateBody(req.body, VALIDATION_SCHEMAS.adjust);
		if (err) return json(400, { error: { code: "INVALID_ARGUMENT", message: err.error } });
		const { adjustmentType } = req.body as { adjustmentType: string };
		if (!VALID_ADJUSTMENT_TYPES.has(adjustmentType)) {
			return json(400, {
				error: {
					code: "INVALID_ARGUMENT",
					message: `Invalid adjustmentType: "${adjustmentType}". Must be one of: ${[...VALID_ADJUSTMENT_TYPES].join(", ")}`,
				},
			});
		}
		const result = await summa.transactions.adjust(
			req.body as Parameters<Summa["transactions"]["adjust"]>[0],
		);
		return json(201, result);
	}),

	defineRoute("POST", "/transactions/journal", async (req, summa) => {
		const err = validateBody(req.body, VALIDATION_SCHEMAS.journal);
		if (err) return json(400, { error: { code: "INVALID_ARGUMENT", message: err.error } });
		const result = await summa.transactions.journal(
			req.body as Parameters<Summa["transactions"]["journal"]>[0],
		);
		return json(201, result);
	}),

	defineRoute("GET", "/transactions/:id", async (_req, summa, params) => {
		const result = await summa.transactions.get(params.id ?? "");
		return json(200, result);
	}),
];
