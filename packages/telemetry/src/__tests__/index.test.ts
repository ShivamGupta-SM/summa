import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTelemetry, isTelemetryEnabled } from "../index.js";

// Mock the client module so sendEvent never makes real HTTP requests
vi.mock("../client.js", () => ({
	sendEvent: vi.fn().mockResolvedValue(undefined),
}));

// Mock the storage module so we don't read/write real files on disk
vi.mock("../storage.js", () => ({
	isTelemetryEnabled: vi.fn().mockReturnValue(false),
	readTelemetryState: vi.fn().mockReturnValue(null),
	writeTelemetryState: vi.fn(),
}));

describe("createTelemetry", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns an object with a track method", () => {
		const telemetry = createTelemetry();
		expect(telemetry).toBeDefined();
		expect(telemetry).toHaveProperty("track");
		expect(typeof telemetry.track).toBe("function");
	});

	it("track is a no-op when disabled (default)", async () => {
		const { sendEvent } = await import("../client.js");
		const telemetry = createTelemetry({ enabled: false });

		telemetry.track("cli.init", { adapter: "pg", plugins: [] });

		expect(sendEvent).not.toHaveBeenCalled();
	});

	it("track is a no-op when options.enabled is explicitly false", async () => {
		const { sendEvent } = await import("../client.js");
		const telemetry = createTelemetry({ enabled: false });

		telemetry.track("cli.generate", { adapter: "pg", tableCount: 5 });

		expect(sendEvent).not.toHaveBeenCalled();
	});

	it("calls sendEvent when enabled is true", async () => {
		const { sendEvent } = await import("../client.js");
		const telemetry = createTelemetry({ enabled: true, version: "1.0.0" });

		telemetry.track("cli.info");

		expect(sendEvent).toHaveBeenCalledTimes(1);
		expect(sendEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "cli.info",
				version: "1.0.0",
				platform: process.platform,
				arch: process.arch,
			}),
			expect.any(Object),
		);
	});

	it("includes timestamp, nodeVersion, platform, and arch in events", async () => {
		const { sendEvent } = await import("../client.js");
		const telemetry = createTelemetry({ enabled: true });

		telemetry.track("cli.status");

		const sentEvent = (sendEvent as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
		expect(sentEvent.timestamp).toBeDefined();
		expect(sentEvent.nodeVersion).toBe(process.version);
		expect(sentEvent.platform).toBe(process.platform);
		expect(sentEvent.arch).toBe(process.arch);
	});

	it("uses 'unknown' as default version when not provided", async () => {
		const { sendEvent } = await import("../client.js");
		const telemetry = createTelemetry({ enabled: true });

		telemetry.track("cli.status");

		const sentEvent = (sendEvent as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
		expect(sentEvent.version).toBe("unknown");
	});

	it("passes custom endpoint to client options", async () => {
		const { sendEvent } = await import("../client.js");
		const telemetry = createTelemetry({
			enabled: true,
			endpoint: "https://custom.endpoint.com",
		});

		telemetry.track("cli.info");

		const clientOptions = (sendEvent as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
		expect(clientOptions.endpoint).toBe("https://custom.endpoint.com");
	});

	it("passes extra properties through to the event", async () => {
		const { sendEvent } = await import("../client.js");
		const telemetry = createTelemetry({ enabled: true });

		telemetry.track("cli.error", {
			command: "migrate",
			message: "connection failed",
		});

		const sentEvent = (sendEvent as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
		expect(sentEvent.properties).toEqual({
			command: "migrate",
			message: "connection failed",
		});
	});
});

describe("isTelemetryEnabled", () => {
	it("returns a boolean", () => {
		const result = isTelemetryEnabled();
		expect(typeof result).toBe("boolean");
	});

	it("returns false by default (opt-in model)", () => {
		const result = isTelemetryEnabled();
		expect(result).toBe(false);
	});
});
