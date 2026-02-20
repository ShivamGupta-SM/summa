/**
 * Convert smallest units (paise/cents) to decimal string.
 * 25490 → "254.90"
 */
export function minorToDecimal(amount: number, currency = "USD"): string {
	const precision = getCurrencyPrecision(currency);
	const major = amount / precision;
	const decimals = getDecimalPlaces(currency);
	return major.toFixed(decimals);
}

/**
 * Get precision (subunit count) for a currency.
 * INR → 100 (100 paise = 1 rupee)
 * USD → 100 (100 cents = 1 dollar)
 */
export function getCurrencyPrecision(currency: string): number {
	switch (currency) {
		case "INR":
		case "USD":
		case "EUR":
		case "GBP":
			return 100;
		case "JPY":
		case "KRW":
			return 1;
		case "BHD":
		case "KWD":
			return 1000;
		default:
			return 100;
	}
}

/**
 * Get decimal places for display.
 */
export function getDecimalPlaces(currency: string): number {
	switch (currency) {
		case "JPY":
		case "KRW":
			return 0;
		case "BHD":
		case "KWD":
			return 3;
		default:
			return 2;
	}
}
