// =============================================================================
// CLIENT ERROR — Typed error from API responses
// =============================================================================

import type { SummaErrorCode } from "@summa/core";

export class SummaClientError extends Error {
	readonly code: SummaErrorCode;
	readonly status: number;
	readonly details?: Record<string, unknown>;

	constructor(
		code: SummaErrorCode,
		message: string,
		status: number,
		details?: Record<string, unknown>,
		options?: { cause?: unknown },
	) {
		super(message, { cause: options?.cause });
		this.name = "SummaClientError";
		this.code = code;
		this.status = status;
		this.details = details;
	}
}
