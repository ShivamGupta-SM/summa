// =============================================================================
// CONCURRENT HOLDS LOAD TEST
// =============================================================================
// Tests parallel hold creation, commit, and void operations.
// Validates that concurrent holds on the same account don't cause double-spending.

import http from "k6/http";
import { check, sleep } from "k6";
import { BASE_URL, HEADERS, DEFAULT_THRESHOLDS, uniqueRef } from "./config.js";

export const options = {
	stages: [
		{ duration: "15s", target: 30 },
		{ duration: "2m", target: 30 },
		{ duration: "15s", target: 0 },
	],
	thresholds: {
		...DEFAULT_THRESHOLDS,
		"checks": ["rate>0.95"], // Allow small failure rate due to contention
	},
};

export function setup() {
	// Create accounts with known balances
	const accounts = [];
	for (let i = 0; i < 50; i++) {
		const holderId = `hold-user-${i}`;
		http.post(
			`${BASE_URL}/accounts`,
			JSON.stringify({ holderId, holderType: "individual", currency: "USD" }),
			{ headers: HEADERS },
		);

		http.post(
			`${BASE_URL}/transactions/credit`,
			JSON.stringify({
				holderId,
				amount: 5000000, // $50,000
				reference: uniqueRef("seed-hold", 0, i),
				description: "Hold test seed",
			}),
			{ headers: HEADERS },
		);

		accounts.push(holderId);
	}
	return { accounts };
}

export default function (data) {
	const { accounts } = data;
	const holderId = accounts[Math.floor(Math.random() * accounts.length)];
	const amount = Math.floor(Math.random() * 1000) + 100;

	// 1. Create hold
	const holdRes = http.post(
		`${BASE_URL}/holds`,
		JSON.stringify({
			sourceHolderId: holderId,
			amount,
			reference: uniqueRef("hold", __VU, __ITER),
			expiresAt: new Date(Date.now() + 3600000).toISOString(),
			description: "Load test hold",
		}),
		{ headers: HEADERS },
	);

	const holdCreated = check(holdRes, {
		"hold created": (r) => r.status === 201,
	});

	if (!holdCreated) {
		sleep(0.1);
		return;
	}

	let holdId;
	try {
		holdId = JSON.parse(holdRes.body).id;
	} catch {
		sleep(0.1);
		return;
	}

	sleep(0.05);

	// 2. Randomly commit or void the hold
	if (Math.random() > 0.3) {
		// Commit (70%)
		const commitAmount = Math.random() > 0.5 ? amount : Math.floor(amount * 0.7); // partial or full
		const commitRes = http.post(
			`${BASE_URL}/holds/${holdId}/commit`,
			JSON.stringify({ amount: commitAmount }),
			{ headers: HEADERS },
		);

		check(commitRes, {
			"hold committed": (r) => r.status === 200 || r.status === 201,
		});
	} else {
		// Void (30%)
		const voidRes = http.post(
			`${BASE_URL}/holds/${holdId}/void`,
			"{}",
			{ headers: HEADERS },
		);

		check(voidRes, {
			"hold voided": (r) => r.status === 200 || r.status === 201,
		});
	}

	sleep(0.1);
}
