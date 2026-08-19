import { describe, expect, it } from "vitest";
import { boundAttemptOutput, subtractUsage } from "../src/runtime/attempt.js";

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
