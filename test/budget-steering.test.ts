import { describe, expect, it } from "vitest";
import {
	budgetStagesForPressure,
	budgetSteeringMessage,
	remainingTotalTokens,
	totalTokens,
	usageBudgetPressures,
} from "../src/runtime/budget.js";

describe("subagent budget steering", () => {
	it("budgets all reported model traffic when configured", () => {
		const usage = {
			input: 72,
			output: 11_239,
			cacheRead: 1_141_500,
			cacheWrite: 79_142,
			totalTokens: 1_231_953,
			cost: 0.54,
		};
		expect(totalTokens(usage)).toBe(1_231_953);
		expect(remainingTotalTokens(10_000_000, usage)).toBe(8_768_047);
		expect(remainingTotalTokens(undefined, usage)).toBeUndefined();
	});

	it("computes independent cost and optional total-token pressure", () => {
		const prior = {
			input: 1,
			output: 1,
			cacheRead: 8,
			cacheWrite: 0,
			totalTokens: 10,
			cost: 1,
		};
		const current = { ...prior, totalTokens: 20, cost: 2 };
		expect(
			usageBudgetPressures({
				prior,
				current,
				limits: { totalTokens: 100, cost: 5 },
			}),
		).toEqual([
			{ trigger: "tokens", used: 30, limit: 100 },
			{ trigger: "cost", used: 3, limit: 5 },
		]);
		expect(
			usageBudgetPressures({ prior, current, limits: { cost: 5 } }),
		).toEqual([{ trigger: "cost", used: 3, limit: 5 }]);
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
		const cost = budgetSteeringMessage({
			stage: 0.7,
			trigger: "cost",
			used: 3.5,
			limit: 5,
		});
		const urgent = budgetSteeringMessage({
			stage: 0.9,
			trigger: "attempt-timeout",
			used: 540_000,
			limit: 600_000,
		});
		expect(advisory).toContain("Converge now");
		expect(advisory).toContain("total model tokens");
		expect(cost).toContain("$3.5000 of $5.0000");
		expect(urgent).toContain("Stop exploring now");
		expect(urgent).toContain("540s of 600s");
	});
});
