// =============================================================================
// SIMPLE TRANSFER LOAD TEST
// =============================================================================
// Tests basic credit, debit, and transfer operations.

import http from "k6/http";
import { check, sleep } from "k6";
import { BASE_URL, HEADERS, DEFAULT_THRESHOLDS, uniqueRef } from "./config.js";

export const options = {
	stages: [
		{ duration: "30s", target: 20 },
		{ duration: "2m", target: 20 },
		{ duration: "30s", target: 0 },
	],
	thresholds: DEFAULT_THRESHOLDS,
};

export function setup() {
	// Create test accounts
	const accounts = [];
	for (let i = 0; i < 100; i++) {
		const res = http.post(
			`${BASE_URL}/accounts`,
			JSON.stringify({
				holderId: `load-user-${i}`,
				holderType: "individual",
				currency: "USD",
			}),
			{ headers: HEADERS },
		);
		if (res.status === 201 || res.status === 409) {
			accounts.push(`load-user-${i}`);
		}
	}

	// Seed balances
	for (const holderId of accounts) {
		http.post(
			`${BASE_URL}/transactions/credit`,
			JSON.stringify({
				holderId,
				amount: 1000000, // $10,000 in cents
				reference: uniqueRef("seed", 0, holderId),
				description: "Load test seed",
			}),
			{ headers: HEADERS },
		);
	}

	return { accounts };
}

export default function (data) {
	const { accounts } = data;
	const srcIdx = Math.floor(Math.random() * accounts.length);
	let dstIdx = Math.floor(Math.random() * accounts.length);
	while (dstIdx === srcIdx) {
		dstIdx = Math.floor(Math.random() * accounts.length);
	}

	const source = accounts[srcIdx];
	const destination = accounts[dstIdx];
	const amount = Math.floor(Math.random() * 100) + 1; // 1-100 cents

	// Transfer
	const res = http.post(
		`${BASE_URL}/transactions/transfer`,
		JSON.stringify({
			sourceHolderId: source,
			destinationHolderId: destination,
			amount,
			reference: uniqueRef("xfer", __VU, __ITER),
			description: "Load test transfer",
		}),
		{ headers: HEADERS },
	);

	check(res, {
		"transfer status is 201": (r) => r.status === 201,
		"transfer has id": (r) => {
			try {
				return JSON.parse(r.body).id !== undefined;
			} catch {
				return false;
			}
		},
	});

	sleep(0.1);
}
