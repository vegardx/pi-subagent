import type {
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createEventBus, type EventBus } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type {
	ExactModelRequest,
	SubagentRequest,
} from "../src/launch-contracts.js";
import { registerSessionModelProvider } from "../src/session-model-provider.js";

const captured = vi.hoisted(() => ({ request: undefined as unknown }));

vi.mock("../src/service.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/service.js")>();
	return {
		...actual,
		createSubagentService: async () => ({
			forOwner: () => ({
				preflight: async (request: SubagentRequest) => {
					captured.request = request;
					throw new Error("preflight reached");
				},
			}),
			shutdown: async () => {},
		}),
	};
});

const { default: piSubagentExtension } = await import("../src/extension.js");

const sessionModel: ExactModelRequest = {
	provider: "anthropic",
	id: "opus-5",
	thinking: "high",
};

function context(): ExtensionContext {
	return {
		cwd: process.cwd(),
		model: { provider: "github-copilot", id: "gpt-5.6-luna" },
		thinkingLevel: "low",
		isProjectTrusted: () => false,
		modelRegistry: {
			getProvider: () => undefined,
			getRegisteredProviderIds: () => [],
			getRegisteredNativeProvider: () => undefined,
		},
		sessionManager: {
			getSessionId: () => "session-tool-session-model",
			getSessionFile: () => undefined,
		},
	} as unknown as ExtensionContext;
}

function subagentTool(events: EventBus): ToolDefinition {
	let tool: ToolDefinition | undefined;
	piSubagentExtension({
		events,
		registerTool(definition: ToolDefinition) {
			tool = definition;
		},
		on() {},
		registerCommand() {},
		registerShortcut() {},
	} as unknown as ExtensionAPI);
	if (!tool) throw new Error("subagent tool was not registered");
	return tool;
}

function launch(
	events: EventBus,
	params: Record<string, unknown>,
): Promise<unknown> {
	captured.request = undefined;
	return Promise.resolve(
		subagentTool(events).execute?.(
			"call-1",
			params as never,
			undefined as never,
			undefined as never,
			context(),
		),
	);
}

async function launchedRequest(
	events: EventBus,
	params: Record<string, unknown>,
): Promise<SubagentRequest> {
	await expect(launch(events, params)).rejects.toThrow("preflight reached");
	return captured.request as SubagentRequest;
}

describe("subagent tool session model", () => {
	it("resolves an inherited model through the provider at the call", async () => {
		const events = createEventBus();
		let current = sessionModel;
		const provider = vi.fn(() => current);
		registerSessionModelProvider(events, provider);

		const first = await launchedRequest(events, {
			agent: "Reviewer",
			task: "Read the contract",
			model: "inherit",
		});
		expect(first.model).toEqual(sessionModel);
		expect(provider).toHaveBeenCalledTimes(1);

		current = {
			provider: "github-copilot",
			id: "gpt-5.6-sol",
			thinking: "low",
		};
		const second = await launchedRequest(events, {
			agent: "Reviewer",
			task: "Read the contract",
			model: "inherit",
		});
		expect(second.model).toEqual(current);
		expect(provider).toHaveBeenCalledTimes(2);
	});

	it("lets an explicit thinking level narrow the inherited model", async () => {
		const events = createEventBus();
		registerSessionModelProvider(events, () => sessionModel);
		const request = await launchedRequest(events, {
			agent: "Reviewer",
			task: "Read the contract",
			model: "inherit",
			thinking: "minimal",
		});
		expect(request.model).toEqual({ ...sessionModel, thinking: "minimal" });
	});

	it("refuses an inherited model when no host offers a session model", async () => {
		await expect(
			launch(createEventBus(), {
				agent: "Reviewer",
				task: "Read the contract",
				model: "inherit",
			}),
		).rejects.toThrow("model inherit: no session model to inherit");
		const empty = createEventBus();
		registerSessionModelProvider(empty, () => undefined);
		await expect(
			launch(empty, {
				agent: "Reviewer",
				task: "Read the contract",
				model: "inherit",
			}),
		).rejects.toThrow("model inherit: no session model to inherit");
	});

	it("keeps the seat's own model when the call names no model", async () => {
		const events = createEventBus();
		const provider = vi.fn(() => sessionModel);
		registerSessionModelProvider(events, provider);
		const request = await launchedRequest(events, {
			agent: "Reviewer",
			task: "Read the contract",
		});
		expect(request.model).toEqual({
			provider: "github-copilot",
			id: "gpt-5.6-luna",
			thinking: "low",
		});
		expect(provider).not.toHaveBeenCalled();
	});

	it("tells the model it can inherit the session's model", () => {
		expect(subagentTool(createEventBus()).description).toContain(
			'model "inherit"',
		);
	});
});
