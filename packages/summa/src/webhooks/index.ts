// =============================================================================
// WEBHOOK HANDLER — Verify and parse incoming webhook payloads
// =============================================================================

import { createHmac, timingSafeEqual } from "node:crypto";

export interface WebhookHandlerOptions {
	/** HMAC-SHA256 secret for signature verification */
	secret: string;
	/** Header name for the signature (default: "x-summa-signature") */
	signatureHeader?: string;
	/** Maximum age of a webhook in milliseconds (default: 5 minutes) */
	tolerance?: number;
}

export interface WebhookPayload {
	id: string;
	event: string;
	timestamp: string;
	data: Record<string, unknown>;
}

export interface WebhookHandler {
	/** Verify a webhook signature. Returns true if valid. */
	verify: (body: string | Buffer, signature: string) => boolean;
	/** Sign a payload body. Returns the hex signature. */
	sign: (body: string | Buffer) => string;
	/** Parse and verify a webhook payload in one step. Throws on invalid signature. */
	receive: (body: string | Buffer, signature: string) => WebhookPayload;
}

/**
 * Create a webhook handler for verifying and parsing Summa webhook payloads.
 *
 * @example
 * ```ts
 * import { createWebhookHandler } from "summa/webhooks";
 *
 * const webhook = createWebhookHandler({ secret: process.env.WEBHOOK_SECRET! });
 *
 * // In your HTTP handler:
 * const payload = webhook.receive(rawBody, req.headers["x-summa-signature"]);
 * ```
 */
export function createWebhookHandler(options: WebhookHandlerOptions): WebhookHandler {
	const { secret, tolerance = 5 * 60 * 1000 } = options;

	function computeSignature(body: string | Buffer): string {
		return createHmac("sha256", secret)
			.update(typeof body === "string" ? body : body)
			.digest("hex");
	}

	function verify(body: string | Buffer, signature: string): boolean {
		const expected = computeSignature(body);
		const expectedBuf = Buffer.from(expected, "hex");
		const signatureBuf = Buffer.from(signature, "hex");

		if (expectedBuf.length !== signatureBuf.length) return false;
		return timingSafeEqual(expectedBuf, signatureBuf);
	}

	function sign(body: string | Buffer): string {
		return computeSignature(body);
	}

	function receive(body: string | Buffer, signature: string): WebhookPayload {
		if (!verify(body, signature)) {
			throw new Error("Invalid webhook signature");
		}

		const payload = JSON.parse(
			typeof body === "string" ? body : body.toString("utf-8"),
		) as WebhookPayload;

		// Check timestamp tolerance
		if (tolerance > 0 && payload.timestamp) {
			const age = Date.now() - new Date(payload.timestamp).getTime();
			if (age > tolerance) {
				throw new Error("Webhook payload is too old");
			}
		}

		return payload;
	}

	return { verify, sign, receive };
}
