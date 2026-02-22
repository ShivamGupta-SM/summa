// =============================================================================
// SMOKE TEST -- Quick sanity check (1 VU, 10 iterations)
// =============================================================================

import http from "k6/http";
import { check, sleep } from "k6";
import { BASE_URL, HEADERS, uniqueRef } from "../config.js";

export const options = {
	vus: 1,
	iterations: 10,
	thresholds: {
		http_req_failed: ["rate==0"],
		http_req_duration: ["p(95)<2000"],
	},
};

export function setup() {
	// Create 2 test accounts
	const alice = "smoke-alice";
	const bob = "smoke-bob";

	http.post(
		`${BASE_URL}/accounts`,
		JSON.stringify({ holderId: alice, holderType: "individual", currency: "USD" }),
		{ headers: HEADERS },
	);
	http.post(
		`${BASE_URL}/accounts`,
		JSON.stringify({ holderId: bob, holderType: "individual", currency: "USD" }),
		{ headers: HEADERS },
	);

	// Seed Alice
	http.post(
		`${BASE_URL}/transactions/credit`,
		JSON.stringify({
			holderId: alice,
			amount: 100000,
			reference: uniqueRef("smoke-seed", 0, 0),
			description: "Smoke test seed",
		}),
		{ headers: HEADERS },
	);

	return { alice, bob };
}

export default function (data) {
	const { alice, bob } = data;

	// 1. Credit
	const creditRes = http.post(
		`${BASE_URL}/transactions/credit`,
		JSON.stringify({
			holderId: alice,
			amount: 100,
			reference: uniqueRef("smoke-credit", __VU, __ITER),
			description: "Smoke credit",
		}),
		{ headers: HEADERS },
	);
	check(creditRes, { "credit ok": (r) => r.status === 201 });

	// 2. Transfer
	const transferRes = http.post(
		`${BASE_URL}/transactions/transfer`,
		JSON.stringify({
			sourceHolderId: alice,
			destinationHolderId: bob,
			amount: 50,
			reference: uniqueRef("smoke-xfer", __VU, __ITER),
			description: "Smoke transfer",
		}),
		{ headers: HEADERS },
	);
	check(transferRes, { "transfer ok": (r) => r.status === 201 });

	// 3. Get balance
	const balanceRes = http.get(`${BASE_URL}/accounts/${alice}/balance`, { headers: HEADERS });
	check(balanceRes, { "balance ok": (r) => r.status === 200 });

	// 4. List transactions
	const listRes = http.get(`${BASE_URL}/transactions?holderId=${alice}&perPage=5`, {
		headers: HEADERS,
	});
	check(listRes, { "list ok": (r) => r.status === 200 });

	sleep(0.5);
}
