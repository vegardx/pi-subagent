import { describe, expect, it } from "vitest";
import type { AgentLaunchPlan } from "../src/launch-contracts.js";
import {
	boundAttemptOutput,
	firstAttemptPrompt,
	INTERRUPTED_RESUME_PROMPT,
	subtractUsage,
} from "../src/runtime/attempt.js";

describe("native attempt result bounds", () => {
	it("accounts only usage added after a resumed-session baseline", () => {
		expect(
			subtractUsage(
				{
					input: 120,
					output: 30,
					cacheRead: 20,
					cacheWrite: 5,
					totalTokens: 175,
					cost: 0.5,
				},
				{
					input: 100,
					output: 10,
					cacheRead: 20,
					cacheWrite: 0,
					totalTokens: 130,
					cost: 0.25,
				},
			),
		).toEqual({
			input: 20,
			output: 20,
			cacheRead: 0,
			cacheWrite: 5,
			totalTokens: 45,
			cost: 0.25,
		});
	});

	it("truncates on Unicode code-point boundaries", () => {
		expect(boundAttemptOutput("😀ab", 5)).toEqual({
			output: "😀a",
			truncated: true,
		});
		expect(boundAttemptOutput("😀ab", 3)).toEqual({
			output: "",
			truncated: true,
		});
		expect(boundAttemptOutput("😀ab", 6)).toEqual({
			output: "😀ab",
			truncated: false,
		});
	});
});

describe("first attempt prompt", () => {
	const plan = {
		task: { goal: "Fix it", context: [], instructions: ["Be brief"] },
	} as unknown as AgentLaunchPlan;

	it("delegates the task to a fresh session", () => {
		expect(firstAttemptPrompt({ plan })).toBe(
			"Goal:\nFix it\n\nInstructions:\n- Be brief",
		);
	});

	it("sends a restored session the resume message verbatim", () => {
		expect(
			firstAttemptPrompt({
				plan,
				resumeSessionFile: "/sessions/a.jsonl",
				resumeMessage: "Findings:\n- rename x",
			}),
		).toBe("Findings:\n- rename x");
		expect(
			firstAttemptPrompt({ plan, resumeSessionFile: "/sessions/a.jsonl" }),
		).toBe(INTERRUPTED_RESUME_PROMPT);
	});

	it("refuses a resume message without a restored session", () => {
		expect(() => firstAttemptPrompt({ plan, resumeMessage: "late" })).toThrow(
			"a resume message requires a restored session",
		);
	});
});
