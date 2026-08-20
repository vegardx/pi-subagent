import type {
	ExtensionAPI,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import piSubagentExtension from "../src/extension.js";

describe("Pi extension adapter", () => {
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
		await handlers.get("session_shutdown")?.({}, { ui: { setWidget() {} } });
		expect(activeProviderRegistrations).toBe(0);
	});
});
