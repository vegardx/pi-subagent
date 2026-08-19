import { describe, expect, it } from "vitest";
import {
	createFinalAnswerController,
	StructuredOutputError,
} from "../src/runtime/structured-output.js";

const schema = {
	type: "object",
	properties: {
		status: { type: "string", enum: ["ok"] },
		count: { type: "integer", minimum: 0 },
	},
	required: ["status", "count"],
	additionalProperties: false,
};

async function execute(
	controller: ReturnType<typeof createFinalAnswerController>,
	value: unknown,
) {
	return controller.tool.execute(
		"final",
		{ value },
		undefined,
		undefined,
		undefined as never,
	);
}

describe("structured final answer", () => {
	it("captures one schema-valid terminating value", async () => {
		const controller = createFinalAnswerController(schema);
		const value = { status: "ok", count: 2 };
		const result = await execute(controller, value);
		expect(result.terminate).toBe(true);
		expect(controller.getValue()).toEqual(value);
		value.count = 3;
		expect(controller.getValue()).toEqual({ status: "ok", count: 2 });
		await expect(
			execute(controller, { status: "ok", count: 4 }),
		).rejects.toThrow("already submitted");
	});

	it("rejects schema-invalid values without capturing them", async () => {
		const controller = createFinalAnswerController(schema);
		await expect(
			execute(controller, { status: "wrong", count: -1 }),
		).rejects.toBeInstanceOf(StructuredOutputError);
		expect(controller.getValue()).toBeUndefined();
	});

	it("rejects malformed and oversized schemas", () => {
		expect(() => createFinalAnswerController("not-an-object")).toThrow(
			"must be a JSON object",
		);
		expect(() =>
			createFinalAnswerController({ type: "unknown-json-schema-type" }),
		).toThrow("schema compilation failed");
		expect(() =>
			createFinalAnswerController({ $async: true, type: "object" }),
		).toThrow("asynchronous JSON schemas are not supported");
		expect(() =>
			createFinalAnswerController({
				type: "object",
				description: "x".repeat(70 * 1024),
			}),
		).toThrow("schema exceeds byte limit");
	});
});
