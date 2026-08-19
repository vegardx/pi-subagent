import type { Api, Model } from "@earendil-works/pi-ai";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vitest";
import {
	createExactModelResolver,
	ModelPreflightError,
	type ModelPreflightRuntime,
	resolveExactPiModel,
} from "../src/preflight/models.js";

const builtin = getBuiltinModel("github-copilot", "gpt-5.6-luna");
const selection = {
	provider: builtin.provider,
	id: builtin.id,
	thinking: "low" as const,
};

function runtime(options?: {
	model?: Model<Api>;
	available?: readonly Model<Api>[];
	error?: Error;
}): ModelPreflightRuntime {
	const model = options?.model ?? builtin;
	return {
		getModel(provider, id) {
			return model.provider === provider && model.id === id ? model : undefined;
		},
		async getAvailable() {
			if (options?.error) throw options.error;
			return options?.available ?? [model];
		},
	};
}

describe("Pi model preflight", () => {
	it("resolves only an authenticated exact model", async () => {
		const result = await resolveExactPiModel(runtime(), selection);
		expect(result.model).toBe(builtin);
		expect(result.selection).toEqual(selection);
		expect(await createExactModelResolver(runtime())(selection)).toEqual(
			selection,
		);
	});

	it("classifies missing models and authentication", async () => {
		await expect(
			resolveExactPiModel(runtime(), { ...selection, id: "missing" }),
		).rejects.toMatchObject({ code: "model-not-found" });
		await expect(
			resolveExactPiModel(runtime({ available: [] }), selection),
		).rejects.toMatchObject({ code: "authentication-unavailable" });
		await expect(
			resolveExactPiModel(
				runtime({ error: new Error("auth failed") }),
				selection,
			),
		).rejects.toBeInstanceOf(ModelPreflightError);
	});

	it("rejects thinking levels the model would clamp", async () => {
		const nonReasoning = { ...builtin, reasoning: false } as Model<Api>;
		await expect(
			resolveExactPiModel(runtime({ model: nonReasoning }), selection),
		).rejects.toMatchObject({ code: "thinking-unsupported" });
	});

	it("preserves cancellation before and during authentication", async () => {
		const before = new AbortController();
		before.abort();
		await expect(
			resolveExactPiModel(runtime(), selection, before.signal),
		).rejects.toMatchObject({ name: "AbortError" });

		const during = new AbortController();
		const cancelling: ModelPreflightRuntime = {
			getModel: runtime().getModel,
			async getAvailable() {
				during.abort();
				throw new Error("cancelled transport");
			},
		};
		await expect(
			resolveExactPiModel(cancelling, selection, during.signal),
		).rejects.toMatchObject({ name: "AbortError" });
	});
});
