import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
	ExtensionAPI,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import piSubagentExtension, {
	discoverExtensionAgents,
} from "../src/extension.js";
import {
	MAX_MEMORY_BYTES,
	MEMORY_GRANULARITY_BYTES,
	MemoryBytesSchema,
	MIN_MEMORY_BYTES,
} from "../src/launch-contracts.js";

function agentDefinition(name: string, prompt: string): string {
	return `---
name: ${name}
model:
  provider: github-copilot
  id: gpt-5.6-luna
  thinking: low
tools: [read]
preloadSkills: []
contextScopes: []
workspaceModes: [read-only]
limits:
  cumulativeRuntimeMs: 60000
  attemptTimeoutMs: 30000
  totalTokens: 100000
  cost: 10
  outputBytes: 1048576
  workspaceWriteBytes: 0
  retries: 0
  resumes: 0
---
${prompt}
`;
}

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const priorAgentDir = process.env[AGENT_DIR_ENV];
let agentDirRoot = "";

// The extension reads host settings from the agent directory while it loads,
// so every test runs against its own directory, never the operator's.
beforeEach(async () => {
	agentDirRoot = path.resolve(".pi", "test-extension-agent", randomUUID());
	await mkdir(path.join(agentDirRoot, "subagents"), { recursive: true });
	process.env[AGENT_DIR_ENV] = agentDirRoot;
});

afterEach(() => {
	if (priorAgentDir === undefined) delete process.env[AGENT_DIR_ENV];
	else process.env[AGENT_DIR_ENV] = priorAgentDir;
});

function recordingApi(): {
	api: ExtensionAPI;
	emit(channel: string, value: unknown): void;
} {
	const handlers = new Map<string, (value: unknown) => void>();
	const api = {
		events: {
			on(channel: string, handler: (value: unknown) => void) {
				handlers.set(channel, handler);
				return () => handlers.delete(channel);
			},
			emit(channel: string, value: unknown) {
				handlers.get(channel)?.(value);
			},
		},
		registerTool() {},
		on() {},
		registerCommand() {},
		registerShortcut() {},
	} as unknown as ExtensionAPI;
	return {
		api,
		emit(channel, value) {
			handlers.get(channel)?.(value);
		},
	};
}

describe("Pi extension host settings", () => {
	function publishedContract(): unknown {
		const recording = recordingApi();
		piSubagentExtension(recording.api);
		let contract: unknown;
		recording.emit("@vegardx/pi-subagent/service-provider/request/v1", {
			schema: "pi-subagent-service-request-v1",
			respond(provider: { contract: unknown }) {
				contract = provider.contract;
			},
		});
		return contract;
	}

	it("publishes the default sixteen slots without a settings file", () => {
		expect(publishedContract()).toMatchObject({
			contractRevision: 12,
			features: { capacityWait: true },
			capacity: { maxSlots: 16 },
		});
	});

	it("publishes the configured maxSlots", async () => {
		await writeFile(
			path.join(agentDirRoot, "subagents", "settings.json"),
			JSON.stringify({ maxSlots: 5 }),
		);
		expect(publishedContract()).toMatchObject({ capacity: { maxSlots: 5 } });
	});

	it("refuses to load with an invalid settings file", async () => {
		const settingsPath = path.join(agentDirRoot, "subagents", "settings.json");
		await writeFile(settingsPath, JSON.stringify({ maxSlots: 64 }));
		expect(() => piSubagentExtension(recordingApi().api)).toThrow(
			`Invalid pi-subagent settings at ${settingsPath}`,
		);
	});
});

describe("Pi extension adapter", () => {
	it("discovers global and trusted-project named agents for shared clients", async () => {
		const root = path.resolve(".pi", "test-extension-agents", randomUUID());
		const agentDir = path.join(root, "agent");
		const cwd = path.join(root, "project");
		await mkdir(path.join(agentDir, "agents"), { recursive: true });
		await mkdir(path.join(cwd, ".pi", "agents"), { recursive: true });
		await writeFile(
			path.join(agentDir, "agents", "researcher.md"),
			agentDefinition("researcher", "global prompt"),
		);
		await writeFile(
			path.join(cwd, ".pi", "agents", "researcher.md"),
			agentDefinition("researcher", "project prompt"),
		);
		const trusted = await discoverExtensionAgents(
			{ cwd, isProjectTrusted: () => true } as never,
			agentDir,
		);
		expect(trusted.get("researcher")?.prompt).toBe("project prompt");
		const untrusted = await discoverExtensionAgents(
			{ cwd, isProjectTrusted: () => false } as never,
			agentDir,
		);
		expect(untrusted.get("researcher")?.prompt).toBe("global prompt");
	});

	it("registers one model-facing subagent tool without eager runtime startup", async () => {
		let tool: ToolDefinition | undefined;
		const events: string[] = [];
		const handlers = new Map<string, (...args: unknown[]) => unknown>();
		const commands: string[] = [];
		const shortcuts: string[] = [];
		const providerChannels: string[] = [];
		let activeProviderRegistrations = 0;
		const api = {
			events: {
				on(channel: string) {
					providerChannels.push(channel);
					activeProviderRegistrations += 1;
					return () => {
						activeProviderRegistrations -= 1;
					};
				},
				emit() {},
			},
			registerTool(definition: ToolDefinition) {
				tool = definition;
			},
			on(event: string, handler: (...args: unknown[]) => unknown) {
				events.push(event);
				handlers.set(event, handler);
			},
			registerCommand(name: string) {
				commands.push(name);
			},
			registerShortcut(shortcut: string) {
				shortcuts.push(shortcut);
			},
		} as unknown as ExtensionAPI;
		piSubagentExtension(api);
		expect(tool?.name).toBe("subagent");
		expect(tool?.description).toContain("Gondolin VM");
		expect(events).toEqual(["session_start", "session_shutdown"]);
		expect(commands).toEqual(["subagents"]);
		expect(shortcuts).toEqual(["alt+s"]);
		expect(providerChannels).toHaveLength(1);
		expect(activeProviderRegistrations).toBe(1);
		const rendered = tool?.renderResult?.(
			{
				content: [{ type: "text", text: "The official Pi website is pi.dev." }],
				details: {},
			},
			{ expanded: false, isPartial: false },
			{ fg: (_color: string, text: string) => text } as never,
			{} as never,
		);
		expect(rendered?.render(100).map((line) => line.trimEnd())).toEqual([
			"",
			"The official Pi website is pi.dev.",
		]);
		await handlers.get("session_shutdown")?.({}, { ui: { setWidget() {} } });
		expect(activeProviderRegistrations).toBe(0);
	});

	it("advertises the guest memory bounds the launch contract enforces", () => {
		let tool: ToolDefinition | undefined;
		const api = {
			events: { on: () => () => {}, emit() {} },
			registerTool(definition: ToolDefinition) {
				tool = definition;
			},
			on() {},
			registerCommand() {},
			registerShortcut() {},
		} as unknown as ExtensionAPI;
		piSubagentExtension(api);
		const parameters = tool?.parameters as unknown as {
			properties: Record<string, Record<string, unknown>>;
		};
		const memory = parameters.properties.memoryBytes;
		const contract = MemoryBytesSchema as unknown as Record<string, unknown>;
		for (const key of ["minimum", "maximum", "multipleOf"]) {
			expect(memory?.[key]).toBe(contract[key]);
		}
		expect(memory?.minimum).toBe(MIN_MEMORY_BYTES);
		expect(memory?.maximum).toBe(MAX_MEMORY_BYTES);
		expect(memory?.multipleOf).toBe(MEMORY_GRANULARITY_BYTES);
	});
});
