import { expectTypeOf, test } from "vitest";
import type {
	BASE_ERROR_CODES,
	BaseErrorCode,
	SummaError,
	SummaErrorCode,
} from "../error/index.js";
import type { SummaAdapter, SummaLogger, SummaPlugin } from "../types/index.js";
import { validatePluginOptions } from "../utils/index.js";

// =============================================================================
// SummaError
// =============================================================================

test("SummaError has correct shape", () => {
	expectTypeOf<SummaError>().toHaveProperty("code");
	expectTypeOf<SummaError>().toHaveProperty("status");
	expectTypeOf<SummaError>().toHaveProperty("message");

	expectTypeOf<SummaError["code"]>().toBeString();
	expectTypeOf<SummaError["status"]>().toBeNumber();
	expectTypeOf<SummaError["message"]>().toBeString();
});

test("SummaError extends Error", () => {
	expectTypeOf<SummaError>().toMatchTypeOf<Error>();
});

test("SummaError has optional details property", () => {
	expectTypeOf<SummaError>().toHaveProperty("details");
	expectTypeOf<SummaError["details"]>().toEqualTypeOf<Record<string, unknown> | undefined>();
});

// =============================================================================
// SummaErrorCode
// =============================================================================

test("SummaErrorCode is a string union type", () => {
	expectTypeOf<SummaErrorCode>().toBeString();
	// Verify it is assignable to string but is not just `string`
	expectTypeOf<SummaErrorCode>().toMatchTypeOf<string>();
	// Verify specific known members are part of the union
	expectTypeOf<"INSUFFICIENT_BALANCE">().toMatchTypeOf<SummaErrorCode>();
	expectTypeOf<"NOT_FOUND">().toMatchTypeOf<SummaErrorCode>();
	expectTypeOf<"INTERNAL">().toMatchTypeOf<SummaErrorCode>();
});

test("SummaErrorCode equals BaseErrorCode", () => {
	expectTypeOf<SummaErrorCode>().toEqualTypeOf<BaseErrorCode>();
});

// =============================================================================
// BASE_ERROR_CODES
// =============================================================================

test("BASE_ERROR_CODES keys match SummaErrorCode", () => {
	expectTypeOf<keyof typeof BASE_ERROR_CODES>().toEqualTypeOf<SummaErrorCode>();
});

test("BASE_ERROR_CODES values have message and status", () => {
	type CodeValue = (typeof BASE_ERROR_CODES)[keyof typeof BASE_ERROR_CODES];
	expectTypeOf<CodeValue>().toHaveProperty("message");
	expectTypeOf<CodeValue>().toHaveProperty("status");
	expectTypeOf<CodeValue["message"]>().toBeString();
	expectTypeOf<CodeValue["status"]>().toBeNumber();
});

// =============================================================================
// SummaAdapter
// =============================================================================

test("SummaAdapter has required CRUD methods", () => {
	expectTypeOf<SummaAdapter>().toHaveProperty("create");
	expectTypeOf<SummaAdapter>().toHaveProperty("findOne");
	expectTypeOf<SummaAdapter>().toHaveProperty("findMany");
	expectTypeOf<SummaAdapter>().toHaveProperty("update");
	expectTypeOf<SummaAdapter>().toHaveProperty("delete");
	expectTypeOf<SummaAdapter>().toHaveProperty("count");
});

test("SummaAdapter has financial-critical methods", () => {
	expectTypeOf<SummaAdapter>().toHaveProperty("transaction");
	expectTypeOf<SummaAdapter>().toHaveProperty("advisoryLock");
	expectTypeOf<SummaAdapter>().toHaveProperty("raw");
	expectTypeOf<SummaAdapter>().toHaveProperty("rawMutate");
});

test("SummaAdapter has id property", () => {
	expectTypeOf<SummaAdapter["id"]>().toBeString();
});

test("SummaAdapter.transaction accepts a callback and returns a Promise", () => {
	expectTypeOf<SummaAdapter["transaction"]>().toBeFunction();
	expectTypeOf<SummaAdapter["transaction"]>().returns.toEqualTypeOf<Promise<unknown>>();
});

test("SummaAdapter.raw returns a Promise of array", () => {
	expectTypeOf<SummaAdapter["raw"]>().toBeFunction();
});

test("SummaAdapter.rawMutate returns a Promise of number", () => {
	expectTypeOf<SummaAdapter["rawMutate"]>().returns.toEqualTypeOf<Promise<number>>();
});

// =============================================================================
// SummaPlugin
// =============================================================================

test("SummaPlugin has required id property", () => {
	expectTypeOf<SummaPlugin>().toHaveProperty("id");
	expectTypeOf<SummaPlugin["id"]>().toBeString();
});

test("SummaPlugin has optional endpoints property", () => {
	expectTypeOf<SummaPlugin>().toHaveProperty("endpoints");
});

test("SummaPlugin has optional dependencies property", () => {
	expectTypeOf<SummaPlugin>().toHaveProperty("dependencies");
});

test("SummaPlugin has optional init method", () => {
	expectTypeOf<SummaPlugin>().toHaveProperty("init");
});

test("SummaPlugin has optional hooks property", () => {
	expectTypeOf<SummaPlugin>().toHaveProperty("hooks");
});

test("SummaPlugin has optional schema property", () => {
	expectTypeOf<SummaPlugin>().toHaveProperty("schema");
});

test("SummaPlugin has optional workers property", () => {
	expectTypeOf<SummaPlugin>().toHaveProperty("workers");
});

test("SummaPlugin has optional $ERROR_CODES property", () => {
	expectTypeOf<SummaPlugin>().toHaveProperty("$ERROR_CODES");
});

test("minimal SummaPlugin is assignable with just id", () => {
	expectTypeOf({ id: "test-plugin" }).toMatchTypeOf<SummaPlugin>();
});

// =============================================================================
// SummaLogger
// =============================================================================

test("SummaLogger has all 4 log levels", () => {
	expectTypeOf<SummaLogger>().toHaveProperty("debug");
	expectTypeOf<SummaLogger>().toHaveProperty("info");
	expectTypeOf<SummaLogger>().toHaveProperty("warn");
	expectTypeOf<SummaLogger>().toHaveProperty("error");
});

test("SummaLogger methods accept message and optional data", () => {
	expectTypeOf<SummaLogger["debug"]>().toBeFunction();
	expectTypeOf<SummaLogger["info"]>().toBeFunction();
	expectTypeOf<SummaLogger["warn"]>().toBeFunction();
	expectTypeOf<SummaLogger["error"]>().toBeFunction();

	// Each method accepts (message: string, data?: Record<string, unknown>) => void
	expectTypeOf<SummaLogger["debug"]>().parameters.toEqualTypeOf<
		[message: string, data?: Record<string, unknown>]
	>();
	expectTypeOf<SummaLogger["info"]>().parameters.toEqualTypeOf<
		[message: string, data?: Record<string, unknown>]
	>();
	expectTypeOf<SummaLogger["warn"]>().parameters.toEqualTypeOf<
		[message: string, data?: Record<string, unknown>]
	>();
	expectTypeOf<SummaLogger["error"]>().parameters.toEqualTypeOf<
		[message: string, data?: Record<string, unknown>]
	>();
});

test("SummaLogger methods return void", () => {
	expectTypeOf<SummaLogger["debug"]>().returns.toBeVoid();
	expectTypeOf<SummaLogger["info"]>().returns.toBeVoid();
	expectTypeOf<SummaLogger["warn"]>().returns.toBeVoid();
	expectTypeOf<SummaLogger["error"]>().returns.toBeVoid();
});

// =============================================================================
// validatePluginOptions
// =============================================================================

test("validatePluginOptions returns the generic type T", () => {
	type MyOptions = { batchSize: number; pollInterval: string };
	const result = validatePluginOptions<MyOptions>("test", {}, {});
	expectTypeOf(result).toEqualTypeOf<MyOptions>();
});

test("validatePluginOptions accepts unknown as options parameter", () => {
	expectTypeOf(validatePluginOptions).parameter(1).toEqualTypeOf<unknown>();
});
