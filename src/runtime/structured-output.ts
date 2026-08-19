import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Ajv, type ValidateFunction } from "ajv";
import type { TSchema } from "typebox";
import { canonicalJson } from "../preflight/canonical.js";

const MAX_OUTPUT_SCHEMA_BYTES = 64 * 1024;

export class StructuredOutputError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "StructuredOutputError";
	}
}

export type FinalAnswerController = {
	tool: ToolDefinition;
	getValue(): unknown | undefined;
};

function compileSchema(schema: unknown): ValidateFunction {
	if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
		throw new StructuredOutputError("output schema must be a JSON object");
	}
	const serialized = canonicalJson(schema);
	if (Buffer.byteLength(serialized) > MAX_OUTPUT_SCHEMA_BYTES) {
		throw new StructuredOutputError("output schema exceeds byte limit");
	}
	if ((schema as { $async?: unknown }).$async === true) {
		throw new StructuredOutputError(
			"asynchronous JSON schemas are not supported",
		);
	}
	try {
		const validate = new Ajv({
			allErrors: false,
			strict: true,
			validateFormats: false,
		}).compile(schema);
		return validate;
	} catch (error) {
		throw new StructuredOutputError("output schema compilation failed", {
			cause: error,
		});
	}
}

export function createFinalAnswerController(
	schema: unknown,
): FinalAnswerController {
	const validate = compileSchema(schema);
	const parameters = {
		type: "object",
		properties: {
			value: schema,
		},
		required: ["value"],
		additionalProperties: false,
	} as TSchema;
	let captured: unknown | undefined;
	const tool: ToolDefinition = {
		name: "final_answer",
		label: "Final answer",
		description:
			"Submit the final structured result. Call this exactly once after completing all other work.",
		parameters,
		async execute(_toolCallId, input) {
			if (captured !== undefined) {
				throw new StructuredOutputError("final answer already submitted");
			}
			const value = (input as { value?: unknown }).value;
			if (!validate(value)) {
				const detail = validate.errors?.[0];
				throw new StructuredOutputError(
					`final answer violates schema${detail ? `: ${detail.instancePath || "/"} ${detail.message ?? "invalid"}` : ""}`,
				);
			}
			captured = JSON.parse(JSON.stringify(value)) as unknown;
			return {
				content: [{ type: "text", text: "Final answer accepted." }],
				details: { value: captured },
				terminate: true,
			};
		},
	};
	return { tool, getValue: () => captured };
}
