import type {
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createEventBus, type EventBus } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { registerDelegationCeilingProvider } from "../src/ceiling-provider.js";
import type { SubagentRequest } from "../src/launch-contracts.js";

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
			getSessionId: () => "session-tool-ceiling",
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

async function launchedRequest(events: EventBus): Promise<SubagentRequest> {
	captured.request = undefined;
	const tool = subagentTool(events);
	await expect(
		tool.execute?.(
			"call-1",
			{ agent: "Reviewer", task: "Read the contract" },
			undefined as never,
			undefined as never,
			context(),
		),
	).rejects.toThrow("preflight reached");
	return captured.request as SubagentRequest;
}

describe("subagent tool delegation ceiling", () => {
	it("attaches the host-registered ceiling to every tool launch", async () => {
		const events = createEventBus();
		registerDelegationCeilingProvider(events, () => ({
			workspaceModes: ["read-only"],
			tools: ["read", "grep"],
		}));
		expect((await launchedRequest(events)).ceiling).toEqual({
			workspaceModes: ["read-only"],
			tools: ["read", "grep"],
		});
	});

	it("sends no ceiling when no host registered one", async () => {
		const request = await launchedRequest(createEventBus());
		expect(request.ceiling).toBeUndefined();
		expect("ceiling" in request).toBe(false);
	});

	it("tells the model that a host bound refuses by name", () => {
		const description = subagentTool(createEventBus()).description;
		expect(description).toContain("The host may bound");
		expect(description).toContain("refused");
	});
});
