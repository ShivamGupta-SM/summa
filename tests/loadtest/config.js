// =============================================================================
// LOAD TEST CONFIGURATION
// =============================================================================
// Shared config for all k6 load test scripts.

export const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";
export const API_KEY = __ENV.API_KEY || "sk_live_test_key";
export const LEDGER_ID = __ENV.LEDGER_ID || "main";

export const HEADERS = {
	"Content-Type": "application/json",
	"X-Api-Key": API_KEY,
	"X-Ledger-Id": LEDGER_ID,
};

// Thresholds used across all tests
export const DEFAULT_THRESHOLDS = {
	http_req_duration: ["p(95)<500", "p(99)<1000"],
	http_req_failed: ["rate<0.01"],
};

// Helper to generate unique references
export function uniqueRef(prefix, vu, iter) {
	return `${prefix}-${vu}-${iter}-${Date.now()}`;
}

// Helper to create an account
export function createAccount(holderId, holderType = "individual", currency = "USD") {
	return {
		holderId,
		holderType,
		currency,
	};
}
