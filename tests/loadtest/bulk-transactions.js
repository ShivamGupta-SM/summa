// =============================================================================
// BULK TRANSACTIONS LOAD TEST
// =============================================================================
// Tests high-volume sequential credit/debit operations.
// Measures throughput (transactions/second) under sustained load.

import http from "k6/http";
import { check } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";
import { BASE_URL, HEADERS, uniqueRef } from "./config.js";

const txnCounter = new Counter("transactions_total");
const txnDuration = new Trend("transaction_duration", true);
const txnFailRate = new Rate("transaction_fail_rate");

export const options = {
	scenarios: {
		sustained_load: {
			executor: "constant-arrival-rate",
			rate: 100, // 100 requests per second
			timeUnit: "1s",
			duration: "3m",
			preAllocatedVUs: 50,
			maxVUs: 200,
		},
	},
	thresholds: {
		transaction_duration: ["p(95)<300"],
		transaction_fail_rate: ["rate<0.02"],
		transactions_total: ["count>15000"], // At least 15k in 3 minutes
	},
};

export function setup() {
	const accounts = [];
	for (let i = 0; i < 500; i++) {
		const holderId = `bulk-user-${i}`;
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
				reference: uniqueRef("seed-bulk", 0, i),
				description: "Bulk test seed",
			}),
			{ headers: HEADERS },
		);

		accounts.push(holderId);
	}
	return { accounts };
}

export default function (data) {
	const { accounts } = data;
	const idx = Math.floor(Math.random() * accounts.length);
	const holderId = accounts[idx];

	// Randomly credit or debit
	const isCredit = Math.random() > 0.5;
	const amount = Math.floor(Math.random() * 100) + 1;
	const endpoint = isCredit ? "credit" : "debit";

	const start = Date.now();

	const res = http.post(
		`${BASE_URL}/transactions/${endpoint}`,
		JSON.stringify({
			holderId,
			amount,
			reference: uniqueRef(endpoint, __VU, __ITER),
			description: `Bulk ${endpoint}`,
		}),
		{ headers: HEADERS },
	);

	const duration = Date.now() - start;
	txnDuration.add(duration);
	txnCounter.add(1);

	const success = check(res, {
		"status is 201": (r) => r.status === 201,
	});

	txnFailRate.add(!success);
}
