import { describe, expect, it } from "vitest";
import {
	budgetStagesForPressure,
	budgetSteeringMessage,
	remainingUncachedTokens,
	uncachedTokens,
} from "../src/runtime/budget.js";

describe("subagent budget steering", () => {
	it("budgets input and output without charging cached tokens", () => {
		const usage = {
			input: 72,
			output: 11_239,
			cacheRead: 1_141_500,
			cacheWrite: 79_142,
			totalTokens: 1_231_953,
			cost: 0.54,
		};
		expect(uncachedTokens(usage)).toBe(11_311);
		expect(remainingUncachedTokens(10_000_000, usage)).toBe(9_988_689);
	});

	it.each([
		[0, []],
		[0.699, []],
		[0.7, [0.7]],
		[0.899, [0.7]],
		[0.9, [0.7, 0.9]],
		[1.1, [0.7, 0.9]],
	] as const)("maps pressure %s to crossed stages", (pressure, stages) => {
		expect(budgetStagesForPressure(pressure)).toEqual(stages);
	});

	it("gives progressively stronger, actionable steering", () => {
		const advisory = budgetSteeringMessage({
			stage: 0.7,
			trigger: "tokens",
			used: 7_000_000,
			limit: 10_000_000,
		});
		const urgent = budgetSteeringMessage({
			stage: 0.9,
			trigger: "attempt-runtime",
			used: 540_000,
			limit: 600_000,
		});
		expect(advisory).toContain("Converge now");
		expect(advisory).toContain("uncached input/output tokens");
		expect(urgent).toContain("Stop exploring now");
		expect(urgent).toContain("540s of 600s");
	});
});
