// =============================================================================
// MULTI-DESTINATION TRANSFER LOAD TEST
// =============================================================================
// Tests 1-to-N split payment transfers under load.

import http from "k6/http";
import { check, sleep } from "k6";
import { BASE_URL, HEADERS, DEFAULT_THRESHOLDS, uniqueRef } from "./config.js";

export const options = {
	stages: [
		{ duration: "15s", target: 10 },
		{ duration: "2m", target: 10 },
		{ duration: "15s", target: 0 },
	],
	thresholds: DEFAULT_THRESHOLDS,
};

export function setup() {
	const accounts = [];
	for (let i = 0; i < 200; i++) {
		const holderId = `multi-user-${i}`;
		http.post(
			`${BASE_URL}/accounts`,
			JSON.stringify({ holderId, holderType: "individual", currency: "USD" }),
			{ headers: HEADERS },
		);

		// Seed with large balance for sources
		if (i < 20) {
			http.post(
				`${BASE_URL}/transactions/credit`,
				JSON.stringify({
					holderId,
					amount: 100000000, // $1M
					reference: uniqueRef("seed-multi", 0, i),
					description: "Multi-transfer seed",
				}),
				{ headers: HEADERS },
			);
		}

		accounts.push(holderId);
	}
	return { accounts };
}

export default function (data) {
	const { accounts } = data;

	// Source is one of the first 20 funded accounts
	const sourceIdx = Math.floor(Math.random() * 20);
	const source = accounts[sourceIdx];

	// 2-5 random destinations
	const numDest = Math.floor(Math.random() * 4) + 2;
	const destinations = [];
	const usedIndexes = new Set([sourceIdx]);

	for (let i = 0; i < numDest; i++) {
		let idx;
		do {
			idx = 20 + Math.floor(Math.random() * 180);
		} while (usedIndexes.has(idx));
		usedIndexes.add(idx);

		destinations.push({
			holderId: accounts[idx],
			amount: Math.floor(Math.random() * 500) + 100,
		});
	}

	const totalAmount = destinations.reduce((sum, d) => sum + d.amount, 0);

	const res = http.post(
		`${BASE_URL}/transactions/multi-transfer`,
		JSON.stringify({
			sourceHolderId: source,
			destinations,
			amount: totalAmount,
			reference: uniqueRef("multi", __VU, __ITER),
			description: `Split to ${numDest} recipients`,
		}),
		{ headers: HEADERS },
	);

	check(res, {
		"multi-transfer status is 201": (r) => r.status === 201,
	});

	sleep(0.2);
}
