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
		const api = {
			registerTool(definition: ToolDefinition) {
				tool = definition;
			},
			on(event: string) {
				events.push(event);
			},
		} as unknown as ExtensionAPI;
		piSubagentExtension(api);
		expect(tool?.name).toBe("subagent");
		expect(tool?.description).toContain("Gondolin VM");
		expect(events).toEqual(["session_shutdown"]);
	});
});
