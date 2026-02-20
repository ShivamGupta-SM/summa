import { describe, expect, it } from "vitest";
import { generateId } from "../utils/id.js";

describe("generateId", () => {
	it("returns a string", () => {
		const id = generateId();
		expect(typeof id).toBe("string");
	});

	it("returns a valid UUID v4 format", () => {
		const id = generateId();
		// UUID v4 format: xxxxxxxx-xxxx-4xxx-[89ab]xxx-xxxxxxxxxxxx
		const uuidV4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
		expect(id).toMatch(uuidV4Regex);
	});

	it("returns unique IDs on each call", () => {
		const ids = new Set<string>();
		for (let i = 0; i < 100; i++) {
			ids.add(generateId());
		}
		expect(ids.size).toBe(100);
	});

	it("has the correct length (36 characters with dashes)", () => {
		const id = generateId();
		expect(id).toHaveLength(36);
	});
});
