import { describe, expect, it } from "vitest";
import type { SubagentRunRequest } from "../src/contracts.js";
import { resolvePiCommand } from "../src/service.js";

function request(
	overrides: Partial<SubagentRunRequest> = {},
): SubagentRunRequest {
	return {
		agent: "reviewer",
		task: "Review the change.",
		cwd: process.cwd(),
		tools: ["read", "grep", "find", "ls"],
		timeoutMs: 60_000,
		...overrides,
	};
}

describe("qualification contracts", () => {
	it("keeps read-only tools explicit", () => {
		expect(request().tools).toEqual(["read", "grep", "find", "ls"]);
	});

	it("resolves the Pi executable without reusing the caller script", () => {
		expect(resolvePiCommand({})).toBe("pi");
		expect(resolvePiCommand({ PI_SUBAGENT_BIN: "/opt/pi" })).toBe("/opt/pi");
	});

	it("allows exact model and thinking overrides", () => {
		expect(
			request({ model: "github-copilot/gpt-5.6-sol", thinking: "high" }),
		).toMatchObject({
			model: "github-copilot/gpt-5.6-sol",
			thinking: "high",
		});
	});
});
