import type {
	ExtensionAPI,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import piSubagentExtension from "../src/extension.js";

describe("Pi extension adapter", () => {
	it("registers one model-facing subagent tool without eager runtime startup", () => {
		let tool: ToolDefinition | undefined;
		const events: string[] = [];
		const commands: string[] = [];
		const shortcuts: string[] = [];
		const api = {
			registerTool(definition: ToolDefinition) {
				tool = definition;
			},
			on(event: string) {
				events.push(event);
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
		expect(shortcuts).toEqual(["alt+shift+s"]);
	});
});
