import {
	createEventBus,
	type EventBus,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { SUBAGENT_RUNTIME_CONTRACT } from "../src/contracts.js";
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
		registerSubagentServiceProvider(events, factory);

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
		registerSubagentServiceProvider(events, first);
		registerSubagentServiceProvider(events, second);

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

	it("removes the provider when its registration is released", async () => {
		const events = createEventBus();
		const unregister = registerSubagentServiceProvider(
			events,
			async () => service,
		);
		unregister();

		await expect(acquireSubagentService(events, context)).rejects.toMatchObject(
			{ code: "missing" },
		);
	});
});
