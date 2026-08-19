import { describe, expect, it } from "vitest";
import { boundAttemptOutput } from "../src/runtime/attempt.js";

describe("native attempt result bounds", () => {
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
