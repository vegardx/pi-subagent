import { createEventBus } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { ExactModelRequest } from "../src/launch-contracts.js";
import {
	registerSessionModelProvider,
	resolveSessionModel,
	SessionModelProviderError,
} from "../src/session-model-provider.js";

const sessionModel: ExactModelRequest = {
	provider: "github-copilot",
	id: "gpt-5.6-sol",
	thinking: "high",
};

describe("session model provider", () => {
	it("resolves the registered provider's model at every launch", () => {
		const events = createEventBus();
		const provider = vi.fn(() => sessionModel);
		registerSessionModelProvider(events, provider);

		expect(provider).not.toHaveBeenCalled();
		expect(resolveSessionModel(events)).toEqual(sessionModel);
		expect(resolveSessionModel(events)).toEqual(sessionModel);
		expect(provider).toHaveBeenCalledTimes(2);
	});

	it("follows the session when the host's answer changes", () => {
		const events = createEventBus();
		let current: ExactModelRequest = sessionModel;
		registerSessionModelProvider(events, () => current);
		expect(resolveSessionModel(events)).toEqual(sessionModel);
		current = { provider: "anthropic", id: "opus-5", thinking: "low" };
		expect(resolveSessionModel(events)).toEqual(current);
	});

	it("means no session model when no provider is registered", () => {
		expect(resolveSessionModel(createEventBus())).toBeUndefined();
	});

	it("means no session model when the provider answers with none", () => {
		const events = createEventBus();
		registerSessionModelProvider(events, () => undefined);
		expect(resolveSessionModel(events)).toBeUndefined();
	});

	it("refuses a second registration and keeps the first", () => {
		const events = createEventBus();
		registerSessionModelProvider(events, () => sessionModel);
		expect(() =>
			registerSessionModelProvider(events, () => ({
				provider: "anthropic",
				id: "opus-5",
				thinking: "low",
			})),
		).toThrow(SessionModelProviderError);
		expect(() => registerSessionModelProvider(events, () => undefined)).toThrow(
			"A pi-subagent session model provider is already registered.",
		);
		expect(resolveSessionModel(events)).toEqual(sessionModel);
	});

	it("accepts a new provider once the first unregisters", () => {
		const events = createEventBus();
		const unregister = registerSessionModelProvider(events, () => sessionModel);
		unregister();
		expect(resolveSessionModel(events)).toBeUndefined();
		registerSessionModelProvider(events, () => ({
			provider: "anthropic",
			id: "opus-5",
			thinking: "low",
		}));
		expect(resolveSessionModel(events)).toEqual({
			provider: "anthropic",
			id: "opus-5",
			thinking: "low",
		});
	});

	it("fails closed on a model that violates the contract", () => {
		const events = createEventBus();
		registerSessionModelProvider(
			events,
			() => ({ provider: "github-copilot", id: "gpt-5.6-sol" }) as never,
		);
		expect(() => resolveSessionModel(events)).toThrowError(
			expect.objectContaining({ code: "invalid" }),
		);
		const maxThinking = createEventBus();
		registerSessionModelProvider(
			maxThinking,
			() => ({ ...sessionModel, thinking: "max" }) as never,
		);
		expect(() => resolveSessionModel(maxThinking)).toThrowError(
			expect.objectContaining({ code: "invalid" }),
		);
	});

	it("fails closed when two providers answer the same launch", () => {
		const events = createEventBus();
		registerSessionModelProvider(events, () => sessionModel);
		const second = createEventBus();
		registerSessionModelProvider(second, () => sessionModel);
		const merged = {
			on: events.on.bind(events),
			emit(channel: string, value: unknown) {
				events.emit(channel, value);
				second.emit(channel, value);
			},
		} as unknown as Parameters<typeof resolveSessionModel>[0];
		expect(() => resolveSessionModel(merged)).toThrowError(
			expect.objectContaining({ code: "duplicate" }),
		);
	});
});
