import { describe, expect, it } from "vitest";
import { getCurrencyPrecision, getDecimalPlaces, minorToDecimal } from "../utils/money.js";

describe("minorToDecimal", () => {
	it("converts USD minor units to decimal string with 2 decimal places", () => {
		// 10000 cents = 100.00 USD (precision=100, decimals=2)
		expect(minorToDecimal(10000, "USD")).toBe("100.00");
	});

	it("converts JPY minor units to decimal string with 0 decimal places", () => {
		// JPY has precision=1, decimals=0, so 10000/1 = "10000"
		expect(minorToDecimal(10000, "JPY")).toBe("10000");
	});

	it("converts BHD minor units to decimal string with 3 decimal places", () => {
		// BHD has precision=1000, decimals=3, so 10000/1000 = "10.000"
		expect(minorToDecimal(10000, "BHD")).toBe("10.000");
	});

	it("converts INR minor units correctly", () => {
		// 25490 paise = 254.90 INR
		expect(minorToDecimal(25490, "INR")).toBe("254.90");
	});

	it("handles zero amount", () => {
		expect(minorToDecimal(0, "USD")).toBe("0.00");
		expect(minorToDecimal(0, "JPY")).toBe("0");
		expect(minorToDecimal(0, "BHD")).toBe("0.000");
	});

	it("handles negative amounts", () => {
		expect(minorToDecimal(-500, "USD")).toBe("-5.00");
		expect(minorToDecimal(-1000, "JPY")).toBe("-1000");
	});

	it("defaults to USD when no currency is provided", () => {
		expect(minorToDecimal(10000)).toBe("100.00");
	});

	it("handles EUR like USD (precision 100, 2 decimal places)", () => {
		expect(minorToDecimal(1550, "EUR")).toBe("15.50");
	});

	it("handles GBP like USD (precision 100, 2 decimal places)", () => {
		expect(minorToDecimal(999, "GBP")).toBe("9.99");
	});

	it("handles KWD with 3 decimal places like BHD", () => {
		expect(minorToDecimal(5000, "KWD")).toBe("5.000");
	});

	it("handles KRW with 0 decimal places like JPY", () => {
		expect(minorToDecimal(50000, "KRW")).toBe("50000");
	});
});

describe("getCurrencyPrecision", () => {
	it("returns 100 for USD", () => {
		expect(getCurrencyPrecision("USD")).toBe(100);
	});

	it("returns 100 for INR", () => {
		expect(getCurrencyPrecision("INR")).toBe(100);
	});

	it("returns 100 for EUR", () => {
		expect(getCurrencyPrecision("EUR")).toBe(100);
	});

	it("returns 100 for GBP", () => {
		expect(getCurrencyPrecision("GBP")).toBe(100);
	});

	it("returns 1 for JPY (zero-decimal currency)", () => {
		expect(getCurrencyPrecision("JPY")).toBe(1);
	});

	it("returns 1 for KRW (zero-decimal currency)", () => {
		expect(getCurrencyPrecision("KRW")).toBe(1);
	});

	it("returns 1000 for BHD (three-decimal currency)", () => {
		expect(getCurrencyPrecision("BHD")).toBe(1000);
	});

	it("returns 1000 for KWD (three-decimal currency)", () => {
		expect(getCurrencyPrecision("KWD")).toBe(1000);
	});

	it("defaults to 100 for unknown currencies", () => {
		expect(getCurrencyPrecision("XYZ")).toBe(100);
		expect(getCurrencyPrecision("UNKNOWN")).toBe(100);
	});
});

describe("getDecimalPlaces", () => {
	it("returns 2 for USD", () => {
		expect(getDecimalPlaces("USD")).toBe(2);
	});

	it("returns 0 for JPY (zero-decimal currency)", () => {
		expect(getDecimalPlaces("JPY")).toBe(0);
	});

	it("returns 0 for KRW (zero-decimal currency)", () => {
		expect(getDecimalPlaces("KRW")).toBe(0);
	});

	it("returns 3 for BHD (three-decimal currency)", () => {
		expect(getDecimalPlaces("BHD")).toBe(3);
	});

	it("returns 3 for KWD (three-decimal currency)", () => {
		expect(getDecimalPlaces("KWD")).toBe(3);
	});

	it("defaults to 2 for unknown currencies", () => {
		expect(getDecimalPlaces("XYZ")).toBe(2);
		expect(getDecimalPlaces("UNKNOWN")).toBe(2);
	});
});
