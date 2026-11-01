import { createEventBus } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { ExactModelRequest } from "../src/launch-contracts.js";
import {
	ModelAdmissionProviderError,
	registerModelAdmissionProvider,
	resolveModelAdmission,
} from "../src/model-admission-provider.js";

const routed: ExactModelRequest = {
	provider: "github-copilot",
	id: "gpt-5.6-sol",
	thinking: "high",
};
const other: ExactModelRequest = {
	provider: "anthropic",
	id: "opus-5",
	thinking: "low",
};

describe("model admission provider", () => {
	it("asks the registered provider about the exact model at every launch", () => {
		const events = createEventBus();
		const provider = vi.fn(
			(model: ExactModelRequest) => model.provider === routed.provider,
		);
		registerModelAdmissionProvider(events, provider);

		expect(provider).not.toHaveBeenCalled();
		expect(resolveModelAdmission(events, routed)).toBe(true);
		expect(resolveModelAdmission(events, other)).toBe(false);
		expect(provider).toHaveBeenNthCalledWith(1, routed);
		expect(provider).toHaveBeenNthCalledWith(2, other);
	});

	it("does not let the provider change the model it is asked about", () => {
		const events = createEventBus();
		registerModelAdmissionProvider(events, (model) => {
			(model as { id: string }).id = "swapped";
			return true;
		});
		const model = { ...routed };
		expect(resolveModelAdmission(events, model)).toBe(true);
		expect(model).toEqual(routed);
	});

	it("means no answer when no provider is registered", () => {
		expect(resolveModelAdmission(createEventBus(), routed)).toBeUndefined();
	});

	it("refuses a second registration and keeps the first", () => {
		const events = createEventBus();
		const first = vi.fn(() => true);
		registerModelAdmissionProvider(events, first);
		expect(() => registerModelAdmissionProvider(events, () => false)).toThrow(
			ModelAdmissionProviderError,
		);
		expect(() => registerModelAdmissionProvider(events, () => false)).toThrow(
			"A pi-subagent model admission provider is already registered.",
		);
		expect(first).not.toHaveBeenCalled();
		expect(resolveModelAdmission(events, routed)).toBe(true);
	});

	it("accepts a new provider once the first unregisters", () => {
		const events = createEventBus();
		const unregister = registerModelAdmissionProvider(events, () => true);
		unregister();
		expect(resolveModelAdmission(events, routed)).toBeUndefined();
		registerModelAdmissionProvider(events, () => false);
		expect(resolveModelAdmission(events, routed)).toBe(false);
	});

	it("fails closed on an answer that is not a boolean", () => {
		for (const answer of ["yes", 1, undefined, null, {}]) {
			const events = createEventBus();
			registerModelAdmissionProvider(events, () => answer as never);
			expect(() => resolveModelAdmission(events, routed)).toThrowError(
				expect.objectContaining({ code: "invalid" }),
			);
		}
	});

	it("fails closed when two providers answer the same launch", () => {
		const events = createEventBus();
		registerModelAdmissionProvider(events, () => true);
		const second = createEventBus();
		registerModelAdmissionProvider(second, () => true);
		const merged = {
			on: events.on.bind(events),
			emit(channel: string, value: unknown) {
				events.emit(channel, value);
				second.emit(channel, value);
			},
		} as unknown as Parameters<typeof resolveModelAdmission>[0];
		expect(() => resolveModelAdmission(merged, routed)).toThrowError(
			expect.objectContaining({ code: "duplicate" }),
		);
	});
});
