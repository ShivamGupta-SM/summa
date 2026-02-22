// =============================================================================
// BALANCE CONSISTENCY VERIFICATION
// =============================================================================
// Performs concurrent transfers between accounts and verifies that total
// system balance remains constant (conservation of money).

import http from "k6/http";
import { check, sleep } from "k6";
import { BASE_URL, HEADERS, uniqueRef } from "./config.js";

const NUM_ACCOUNTS = 20;
const SEED_AMOUNT = 1000000; // $10,000

export const options = {
	stages: [
		{ duration: "15s", target: 20 },
		{ duration: "1m", target: 20 },
		{ duration: "10s", target: 0 },
	],
	thresholds: {
		http_req_duration: ["p(95)<1000"],
		http_req_failed: ["rate<0.05"],
	},
};

export function setup() {
	const accounts = [];
	for (let i = 0; i < NUM_ACCOUNTS; i++) {
		const holderId = `consistency-user-${i}`;
		http.post(
			`${BASE_URL}/accounts`,
			JSON.stringify({ holderId, holderType: "individual", currency: "USD" }),
			{ headers: HEADERS },
		);

		http.post(
			`${BASE_URL}/transactions/credit`,
			JSON.stringify({
				holderId,
				amount: SEED_AMOUNT,
				reference: uniqueRef("seed-cons", 0, i),
				description: "Consistency test seed",
			}),
			{ headers: HEADERS },
		);

		accounts.push(holderId);
	}

	// Record initial total
	const expectedTotal = NUM_ACCOUNTS * SEED_AMOUNT;
	return { accounts, expectedTotal };
}

export default function (data) {
	const { accounts } = data;
	const srcIdx = Math.floor(Math.random() * accounts.length);
	let dstIdx = Math.floor(Math.random() * accounts.length);
	while (dstIdx === srcIdx) {
		dstIdx = Math.floor(Math.random() * accounts.length);
	}

	const amount = Math.floor(Math.random() * 50) + 1;

	const res = http.post(
		`${BASE_URL}/transactions/transfer`,
		JSON.stringify({
			sourceHolderId: accounts[srcIdx],
			destinationHolderId: accounts[dstIdx],
			amount,
			reference: uniqueRef("cons", __VU, __ITER),
			description: "Consistency test transfer",
		}),
		{ headers: HEADERS },
	);

	check(res, {
		"transfer ok": (r) => r.status === 201 || r.status === 402, // 402 = insufficient balance is ok
	});

	sleep(0.05);
}

export function teardown(data) {
	const { accounts, expectedTotal } = data;

	// Verify total balance across all accounts
	let totalBalance = 0;
	for (const holderId of accounts) {
		const res = http.get(`${BASE_URL}/accounts/${holderId}/balance`, { headers: HEADERS });
		if (res.status === 200) {
			try {
				const body = JSON.parse(res.body);
				totalBalance += body.balance || 0;
			} catch {
				// skip
			}
		}
	}

	console.log(`\n=== BALANCE CONSISTENCY CHECK ===`);
	console.log(`Expected total: ${expectedTotal}`);
	console.log(`Actual total:   ${totalBalance}`);
	console.log(`Difference:     ${totalBalance - expectedTotal}`);
	console.log(`Result:         ${totalBalance === expectedTotal ? "PASS" : "FAIL"}`);
	console.log(`=================================\n`);

	check(null, {
		"balance conservation": () => totalBalance === expectedTotal,
	});
}
