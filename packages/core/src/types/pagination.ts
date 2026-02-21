export interface PaginationParams {
	page?: number;
	perPage?: number;
	/** Opaque cursor for keyset pagination. When provided, page/perPage are ignored. */
	cursor?: string;
	/** Number of items per page when using cursor pagination. Default: 20, max: 100. */
	limit?: number;
}

export interface PaginatedResult<T> {
	data: T[];
	hasMore: boolean;
	total: number;
	/** Opaque cursor for fetching the next page. Undefined when no more pages. */
	nextCursor?: string;
}

// =============================================================================
// CURSOR HELPERS
// =============================================================================

export interface CursorPayload {
	/** created_at ISO timestamp */
	ca: string;
	/** row id (UUID) */
	id: string;
}

/** Encode a cursor from created_at + id. */
export function encodeCursor(createdAt: string | Date, id: string): string {
	const payload: CursorPayload = {
		ca: typeof createdAt === "string" ? createdAt : createdAt.toISOString(),
		id,
	};
	return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

/** Decode an opaque cursor string. Returns null if invalid. */
export function decodeCursor(cursor: string): CursorPayload | null {
	try {
		const json = Buffer.from(cursor, "base64url").toString("utf-8");
		const parsed = JSON.parse(json) as CursorPayload;
		if (typeof parsed.ca !== "string" || typeof parsed.id !== "string") return null;
		return parsed;
	} catch {
		return null;
	}
}
