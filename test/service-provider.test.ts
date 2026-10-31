import {
	createEventBus,
	type EventBus,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
	createSubagentRuntimeContract,
	SUBAGENT_RUNTIME_CONTRACT,
} from "../src/contracts.js";
import type { SubagentService } from "../src/service.js";
import {
	acquireSubagentService,
	registerSubagentServiceProvider,
} from "../src/service-provider.js";

const context = {} as ExtensionContext;
const service = {} as SubagentService;

describe("subagent service provider", () => {
	it("acquires the exact lazily provided service", async () => {
		const events = createEventBus();
		const factory = vi.fn(async () => service);
		registerSubagentServiceProvider(events, SUBAGENT_RUNTIME_CONTRACT, factory);

		expect(factory).not.toHaveBeenCalled();
		await expect(acquireSubagentService(events, context)).resolves.toBe(
			service,
		);
		expect(factory).toHaveBeenCalledOnce();
		expect(factory).toHaveBeenCalledWith(context);
	});

	it("fails when no provider is registered", async () => {
		await expect(
			acquireSubagentService(createEventBus(), context),
		).rejects.toMatchObject({
			code: "missing",
		});
	});

	it("fails when more than one provider is registered", async () => {
		const events = createEventBus();
		const first = vi.fn(async () => service);
		const second = vi.fn(async () => service);
		registerSubagentServiceProvider(events, SUBAGENT_RUNTIME_CONTRACT, first);
		registerSubagentServiceProvider(events, SUBAGENT_RUNTIME_CONTRACT, second);

		await expect(acquireSubagentService(events, context)).rejects.toMatchObject(
			{ code: "duplicate" },
		);
		expect(first).not.toHaveBeenCalled();
		expect(second).not.toHaveBeenCalled();
	});

	it("fails closed for an incompatible provider", async () => {
		const events: EventBus = {
			on() {
				return () => {};
			},
			emit(_channel, value) {
				const request = value as { respond(provider: unknown): void };
				request.respond({
					contract: {
						...SUBAGENT_RUNTIME_CONTRACT,
						features: {
							...SUBAGENT_RUNTIME_CONTRACT.features,
							structuredOutput: false,
						},
					},
					acquire: async () => service,
				});
			},
		};

		await expect(acquireSubagentService(events, context)).rejects.toMatchObject(
			{ code: "incompatible" },
		);
	});

	it("rejects provider removal while acquisition is pending", async () => {
		const events = createEventBus();
		let resolveService: ((value: SubagentService) => void) | undefined;
		let started: (() => void) | undefined;
		const acquisitionStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		const pending = new Promise<SubagentService>((resolve) => {
			resolveService = resolve;
		});
		const unregister = registerSubagentServiceProvider(
			events,
			SUBAGENT_RUNTIME_CONTRACT,
			async () => {
				started?.();
				return pending;
			},
		);
		const acquisition = acquireSubagentService(events, context);
		await acquisitionStarted;
		unregister();
		resolveService?.(service);
		await expect(acquisition).rejects.toMatchObject({ code: "missing" });
	});

	it("rejects provider replacement while acquisition is pending", async () => {
		const events = createEventBus();
		let resolveService: ((value: SubagentService) => void) | undefined;
		let started: (() => void) | undefined;
		const acquisitionStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		const pending = new Promise<SubagentService>((resolve) => {
			resolveService = resolve;
		});
		const unregister = registerSubagentServiceProvider(
			events,
			SUBAGENT_RUNTIME_CONTRACT,
			async () => {
				started?.();
				return pending;
			},
		);
		const acquisition = acquireSubagentService(events, context);
		await acquisitionStarted;
		unregister();
		registerSubagentServiceProvider(
			events,
			SUBAGENT_RUNTIME_CONTRACT,
			async () => service,
		);
		resolveService?.(service);
		await expect(acquisition).rejects.toMatchObject({ code: "replaced" });
	});

	it("classifies throwing provider accessors as incompatible", async () => {
		const events: EventBus = {
			on() {
				return () => {};
			},
			emit(_channel, value) {
				const request = value as { respond(provider: unknown): void };
				request.respond(
					Object.defineProperty({}, "acquire", {
						get() {
							throw new Error("broken accessor");
						},
					}),
				);
			},
		};
		await expect(acquireSubagentService(events, context)).rejects.toMatchObject(
			{
				code: "incompatible",
			},
		);
	});

	it("publishes the contract it was given, with its slot count", async () => {
		const events = createEventBus();
		const contract = createSubagentRuntimeContract({ maxSlots: 3 });
		registerSubagentServiceProvider(events, contract, async () => service);
		let published: unknown;
		events.emit("@vegardx/pi-subagent/service-provider/request/v1", {
			schema: "pi-subagent-service-request-v1",
			respond(provider: { contract: unknown }) {
				published = provider.contract;
			},
		});
		expect(published).toBe(contract);
		expect(contract.capacity).toEqual({ maxSlots: 3 });
		await expect(acquireSubagentService(events, context)).resolves.toBe(
			service,
		);
	});

	it("refuses to publish a contract outside the schema", () => {
		expect(() =>
			registerSubagentServiceProvider(
				createEventBus(),
				{ ...SUBAGENT_RUNTIME_CONTRACT, capacity: { maxSlots: 33 } },
				async () => service,
			),
		).toThrow("runtime contract to publish is invalid");
	});

	it("freezes the advertised runtime contract", () => {
		expect(Object.isFrozen(SUBAGENT_RUNTIME_CONTRACT)).toBe(true);
		expect(Object.isFrozen(SUBAGENT_RUNTIME_CONTRACT.features)).toBe(true);
		expect(Object.isFrozen(SUBAGENT_RUNTIME_CONTRACT.capacity)).toBe(true);
		expect(() => {
			SUBAGENT_RUNTIME_CONTRACT.features.structuredOutput = false;
		}).toThrow(TypeError);
	});

	it("removes the provider when its registration is released", async () => {
		const events = createEventBus();
		const unregister = registerSubagentServiceProvider(
			events,
			SUBAGENT_RUNTIME_CONTRACT,
			async () => service,
		);
		unregister();

		await expect(acquireSubagentService(events, context)).rejects.toMatchObject(
			{ code: "missing" },
		);
	});
});
