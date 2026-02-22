// =============================================================================
// ACCOUNT & CHART OF ACCOUNTS ROUTES
// =============================================================================

import type { AccountStatus, HolderType } from "@summa-ledger/core";
import type { Summa } from "../../summa/base.js";
import type { Route } from "../handler.js";
import { defineRoute, json } from "../handler.js";
import {
	VALID_ACCOUNT_STATUSES,
	VALID_HOLDER_TYPES,
	validateBody,
	validateEnum,
} from "../validation.js";

export const accountRoutes: Route[] = [
	defineRoute("GET", "/accounts", async (req, summa) => {
		const statusErr = validateEnum(req.query.status, VALID_ACCOUNT_STATUSES, "status");
		if (statusErr) return statusErr;
		const holderTypeErr = validateEnum(req.query.holderType, VALID_HOLDER_TYPES, "holderType");
		if (holderTypeErr) return holderTypeErr;
		const result = await summa.accounts.list({
			page: req.query.page ? Number(req.query.page) : undefined,
			perPage: req.query.perPage ? Number(req.query.perPage) : undefined,
			status: req.query.status as AccountStatus | undefined,
			holderType: req.query.holderType as HolderType | undefined,
			search: req.query.search,
		});
		return json(200, result);
	}),

	defineRoute("POST", "/accounts", async (req, summa) => {
		const err = validateBody(req.body, {
			holderId: "string",
			holderType: "string",
			currency: "string?",
		});
		if (err) return json(400, { error: { code: "INVALID_ARGUMENT", message: err.error } });
		const { holderType } = req.body as { holderType: string };
		const holderTypeErr = validateEnum(holderType, VALID_HOLDER_TYPES, "holderType");
		if (holderTypeErr) return holderTypeErr;
		const result = await summa.accounts.create(
			req.body as Parameters<Summa["accounts"]["create"]>[0],
		);
		return json(201, result);
	}),

	defineRoute("GET", "/accounts/:holderId/balance", async (req, summa, params) => {
		const asOf = req.query.asOf;
		const result = await summa.accounts.getBalance(
			params.holderId ?? "",
			asOf ? { asOf } : undefined,
		);
		return json(200, result);
	}),

	defineRoute("POST", "/accounts/:holderId/freeze", async (req, summa, params) => {
		const err = validateBody(req.body, { reason: "string", frozenBy: "string" });
		if (err) return json(400, { error: { code: "INVALID_ARGUMENT", message: err.error } });
		const body = req.body as { reason: string; frozenBy: string };
		const result = await summa.accounts.freeze({ ...body, holderId: params.holderId ?? "" });
		return json(200, result);
	}),

	defineRoute("POST", "/accounts/:holderId/unfreeze", async (req, summa, params) => {
		const err = validateBody(req.body, { unfrozenBy: "string", reason: "string?" });
		if (err) return json(400, { error: { code: "INVALID_ARGUMENT", message: err.error } });
		const body = req.body as { unfrozenBy: string; reason?: string };
		const result = await summa.accounts.unfreeze({ ...body, holderId: params.holderId ?? "" });
		return json(200, result);
	}),

	defineRoute("POST", "/accounts/:holderId/close", async (req, summa, params) => {
		const err = validateBody(req.body, {
			closedBy: "string",
			reason: "string?",
			transferToHolderId: "string?",
		});
		if (err) return json(400, { error: { code: "INVALID_ARGUMENT", message: err.error } });
		const body = req.body as { closedBy: string; reason?: string; transferToHolderId?: string };
		const result = await summa.accounts.close({ ...body, holderId: params.holderId ?? "" });
		return json(200, result);
	}),

	defineRoute("PATCH", "/accounts/:holderId/overdraft", async (req, summa, params) => {
		const err = validateBody(req.body, {
			allowOverdraft: "boolean",
			overdraftLimit: "number?",
		});
		if (err) return json(400, { error: { code: "INVALID_ARGUMENT", message: err.error } });
		const body = req.body as { allowOverdraft: boolean; overdraftLimit?: number };
		const result = await summa.accounts.updateOverdraft({
			...body,
			holderId: params.holderId ?? "",
		});
		return json(200, result);
	}),

	defineRoute("GET", "/accounts/:holderId", async (_req, summa, params) => {
		const result = await summa.accounts.get(params.holderId ?? "");
		return json(200, result);
	}),

	// --- Chart of Accounts ---
	defineRoute("GET", "/chart-of-accounts/by-type", async (req, summa) => {
		const accountType = req.query.accountType;
		if (!accountType) {
			return json(400, {
				error: { code: "INVALID_ARGUMENT", message: 'Missing required query param: "accountType"' },
			});
		}
		const result = await summa.chartOfAccounts.getByType(
			accountType as Parameters<Summa["chartOfAccounts"]["getByType"]>[0],
		);
		return json(200, result);
	}),

	defineRoute("GET", "/chart-of-accounts/hierarchy", async (req, summa) => {
		const result = await summa.chartOfAccounts.getHierarchy(req.query.rootAccountId);
		return json(200, result);
	}),

	defineRoute("GET", "/chart-of-accounts/validate", async (_req, summa) => {
		const result = await summa.chartOfAccounts.validateEquation();
		return json(200, result);
	}),

	defineRoute("GET", "/chart-of-accounts/:accountId/children", async (_req, summa, params) => {
		const result = await summa.chartOfAccounts.getChildren(params.accountId ?? "");
		return json(200, result);
	}),
];
