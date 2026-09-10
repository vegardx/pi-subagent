import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
	ExtensionAPI,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import piSubagentExtension, {
	discoverExtensionAgents,
} from "../src/extension.js";

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
});
