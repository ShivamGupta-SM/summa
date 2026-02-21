// =============================================================================
// REQUEST HELPERS — Shared request parsing for API framework adapters
// =============================================================================
// Eliminates duplicated path/query/header/body parsing across
// fetch, hono, elysia (Web API) and express, fastify (Node API) adapters.

import type { ApiRequest } from "./handler.js";

// =============================================================================
// WEB API HELPERS (fetch, hono, elysia)
// =============================================================================

/** Strip basePath prefix from a URL pathname, returning the relative path. */
export function stripBasePath(pathname: string, basePath: string): string {
	if (basePath && pathname.startsWith(basePath)) {
		return pathname.slice(basePath.length) || "/";
	}
	return pathname;
}

/** Extract query params from a URL's searchParams into a plain object. */
export function parseSearchParams(
	searchParams: URLSearchParams,
): Record<string, string | undefined> {
	const query: Record<string, string | undefined> = {};
	for (const [key, value] of searchParams) {
		query[key] = value;
	}
	return query;
}

/** Extract headers from a Web Headers object into a plain object. */
export function parseWebHeaders(headers: Headers): Record<string, string> {
	const result: Record<string, string> = {};
	headers.forEach((value, key) => {
		result[key] = value;
	});
	return result;
}

/** Parse the body from a Web Request (returns {} for GET/HEAD or parse failures). */
export async function parseWebBody(request: {
	method: string;
	json: () => Promise<unknown>;
}): Promise<unknown> {
	if (request.method === "GET" || request.method === "HEAD") {
		return undefined;
	}
	try {
		return await request.json();
	} catch {
		return {};
	}
}

/**
 * Build a full ApiRequest from a Web API Request, stripping the basePath.
 * Used by fetch and hono adapters.
 */
export async function parseWebApiRequest(request: Request, basePath: string): Promise<ApiRequest> {
	const url = new URL(request.url);
	return {
		method: request.method,
		path: stripBasePath(url.pathname, basePath),
		body: await parseWebBody(request),
		query: parseSearchParams(url.searchParams),
		headers: parseWebHeaders(request.headers),
	};
}

// =============================================================================
// NODE API HELPERS (express, fastify)
// =============================================================================

/** Convert a Node-style query object (values may be non-string) to string values. */
export function parseNodeQuery(raw: Record<string, unknown>): Record<string, string | undefined> {
	const query: Record<string, string | undefined> = {};
	for (const [key, value] of Object.entries(raw)) {
		query[key] = typeof value === "string" ? value : undefined;
	}
	return query;
}

/** Flatten Node-style headers (string | string[] | undefined) to a plain string record. */
export function parseNodeHeaders(
	raw: Record<string, string | string[] | undefined>,
): Record<string, string> {
	const headers: Record<string, string> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (typeof value === "string") {
			headers[key] = value;
		} else if (Array.isArray(value) && value.length > 0) {
			headers[key] = value[0] as string;
		}
	}
	return headers;
}
