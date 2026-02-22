// =============================================================================
// STRESS TEST -- High load with ramp up/down (200 VUs peak)
// =============================================================================

import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Rate } from "k6/metrics";
import { BASE_URL, HEADERS, uniqueRef } from "../config.js";

const txnTotal = new Counter("stress_txn_total");
const txnErrors = new Rate("stress_txn_errors");

export const options = {
	stages: [
		{ duration: "30s", target: 50 },    // Ramp up
		{ duration: "1m", target: 100 },     // Increase
		{ duration: "2m", target: 200 },     // Peak
		{ duration: "1m", target: 100 },     // Cool down
		{ duration: "30s", target: 0 },      // Ramp down
	],
	thresholds: {
		http_req_duration: ["p(95)<1000", "p(99)<3000"],
		http_req_failed: ["rate<0.05"],
		stress_txn_errors: ["rate<0.05"],
	},
};

export function setup() {
	const accounts = [];
	for (let i = 0; i < 1000; i++) {
		const holderId = `stress-user-${i}`;
		http.post(
			`${BASE_URL}/accounts`,
			JSON.stringify({ holderId, holderType: "individual", currency: "USD" }),
			{ headers: HEADERS },
		);
		http.post(
			`${BASE_URL}/transactions/credit`,
			JSON.stringify({
				holderId,
				amount: 100000000,
				reference: uniqueRef("seed-stress", 0, i),
				description: "Stress seed",
			}),
			{ headers: HEADERS },
		);
		accounts.push(holderId);
	}
	return { accounts };
}

export default function (data) {
	const { accounts } = data;
	const op = Math.random();

	if (op < 0.4) {
		// 40% transfers
		const src = accounts[Math.floor(Math.random() * accounts.length)];
		let dst;
		do {
			dst = accounts[Math.floor(Math.random() * accounts.length)];
		} while (dst === src);

		const res = http.post(
			`${BASE_URL}/transactions/transfer`,
			JSON.stringify({
				sourceHolderId: src,
				destinationHolderId: dst,
				amount: Math.floor(Math.random() * 100) + 1,
				reference: uniqueRef("stress-xfer", __VU, __ITER),
				description: "Stress transfer",
			}),
			{ headers: HEADERS },
		);

		const ok = check(res, { "transfer ok": (r) => r.status === 201 || r.status === 402 });
		txnTotal.add(1);
		txnErrors.add(!ok);
	} else if (op < 0.7) {
		// 30% credits
		const holderId = accounts[Math.floor(Math.random() * accounts.length)];
		const res = http.post(
			`${BASE_URL}/transactions/credit`,
			JSON.stringify({
				holderId,
				amount: Math.floor(Math.random() * 500) + 1,
				reference: uniqueRef("stress-credit", __VU, __ITER),
				description: "Stress credit",
			}),
			{ headers: HEADERS },
		);

		const ok = check(res, { "credit ok": (r) => r.status === 201 });
		txnTotal.add(1);
		txnErrors.add(!ok);
	} else if (op < 0.9) {
		// 20% balance reads
		const holderId = accounts[Math.floor(Math.random() * accounts.length)];
		const res = http.get(`${BASE_URL}/accounts/${holderId}/balance`, { headers: HEADERS });
		check(res, { "balance ok": (r) => r.status === 200 });
	} else {
		// 10% transaction list
		const holderId = accounts[Math.floor(Math.random() * accounts.length)];
		const res = http.get(`${BASE_URL}/transactions?holderId=${holderId}&perPage=10`, {
			headers: HEADERS,
		});
		check(res, { "list ok": (r) => r.status === 200 });
	}

	sleep(0.05);
}
