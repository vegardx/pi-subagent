import { createEventBus } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
	DelegationCeilingProviderError,
	registerDelegationCeilingProvider,
	resolveDelegationCeiling,
} from "../src/ceiling-provider.js";
import type { DelegationCeiling } from "../src/launch-contracts.js";

const readOnly: DelegationCeiling = {
	workspaceModes: ["read-only"],
	tools: ["read", "grep"],
};

describe("delegation ceiling provider", () => {
	it("resolves the registered provider's ceiling at every launch", () => {
		const events = createEventBus();
		const provider = vi.fn(() => readOnly);
		registerDelegationCeilingProvider(events, provider);

		expect(provider).not.toHaveBeenCalled();
		expect(resolveDelegationCeiling(events)).toEqual(readOnly);
		expect(resolveDelegationCeiling(events)).toEqual(readOnly);
		expect(provider).toHaveBeenCalledTimes(2);
	});

	it("means no bound when no provider is registered", () => {
		expect(resolveDelegationCeiling(createEventBus())).toBeUndefined();
	});

	it("means no bound when the provider answers with none", () => {
		const events = createEventBus();
		registerDelegationCeilingProvider(events, () => undefined);
		expect(resolveDelegationCeiling(events)).toBeUndefined();
	});

	it("refuses a second registration and keeps the first", () => {
		const events = createEventBus();
		const first = vi.fn(() => readOnly);
		registerDelegationCeilingProvider(events, first);
		expect(() =>
			registerDelegationCeilingProvider(events, () => ({
				workspaceModes: ["worktree"],
			})),
		).toThrow(DelegationCeilingProviderError);
		expect(() =>
			registerDelegationCeilingProvider(events, () => undefined),
		).toThrow(
			"A pi-subagent delegation ceiling provider is already registered.",
		);
		expect(resolveDelegationCeiling(events)).toEqual(readOnly);
	});

	it("accepts a new provider once the first unregisters", () => {
		const events = createEventBus();
		const unregister = registerDelegationCeilingProvider(
			events,
			() => readOnly,
		);
		unregister();
		expect(resolveDelegationCeiling(events)).toBeUndefined();
		registerDelegationCeilingProvider(events, () => ({
			workspaceModes: ["worktree"],
		}));
		expect(resolveDelegationCeiling(events)).toEqual({
			workspaceModes: ["worktree"],
		});
	});

	it("fails closed on a ceiling that violates the contract", () => {
		const events = createEventBus();
		registerDelegationCeilingProvider(
			events,
			() => ({ workspaceModes: ["host-only"] }) as never,
		);
		expect(() => resolveDelegationCeiling(events)).toThrowError(
			expect.objectContaining({ code: "invalid" }),
		);
	});

	it("fails closed when two providers answer the same launch", () => {
		const events = createEventBus();
		registerDelegationCeilingProvider(events, () => readOnly);
		const second = createEventBus();
		registerDelegationCeilingProvider(second, () => readOnly);
		const merged = {
			on: events.on.bind(events),
			emit(channel: string, value: unknown) {
				events.emit(channel, value);
				second.emit(channel, value);
			},
		} as unknown as Parameters<typeof resolveDelegationCeiling>[0];
		expect(() => resolveDelegationCeiling(merged)).toThrowError(
			expect.objectContaining({ code: "duplicate" }),
		);
	});
});
