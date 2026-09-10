import type { Usage } from "../contracts.js";

export const BUDGET_STEERING_STAGES = [0.7, 0.9] as const;
export type BudgetSteeringStage = (typeof BUDGET_STEERING_STAGES)[number];
export type BudgetSteeringTrigger =
	| "tokens"
	| "cost"
	| "cumulative-runtime"
	| "attempt-timeout";

export function totalTokens(usage: Usage): number {
	return usage.totalTokens;
}

export function remainingTotalTokens(
	limit: number | undefined,
	usage: Usage,
): number | undefined {
	return limit === undefined ? undefined : limit - totalTokens(usage);
}

export function usageBudgetPressures(input: {
	prior: Usage;
	current: Usage;
	limits: { cost: number; totalTokens?: number };
}): readonly {
	trigger: "tokens" | "cost";
	used: number;
	limit: number;
}[] {
	const pressures: Array<{
		trigger: "tokens" | "cost";
		used: number;
		limit: number;
	}> = [];
	if (input.limits.totalTokens !== undefined) {
		pressures.push({
			trigger: "tokens",
			used: totalTokens(input.prior) + totalTokens(input.current),
			limit: input.limits.totalTokens,
		});
	}
	pressures.push({
		trigger: "cost",
		used: input.prior.cost + input.current.cost,
		limit: input.limits.cost,
	});
	return pressures;
}

export function budgetStagesForPressure(
	pressure: number,
): BudgetSteeringStage[] {
	return BUDGET_STEERING_STAGES.filter((stage) => pressure >= stage);
}

export function budgetSteeringMessage(input: {
	stage: BudgetSteeringStage;
	trigger: BudgetSteeringTrigger;
	used: number;
	limit: number;
}): string {
	const percentage = Math.min(
		100,
		Math.round((input.used / input.limit) * 100),
	);
	const basis =
		input.trigger === "tokens"
			? `${input.used.toLocaleString()} of ${input.limit.toLocaleString()} total model tokens`
			: input.trigger === "cost"
				? `$${input.used.toFixed(4)} of $${input.limit.toFixed(4)}`
				: `${Math.ceil(input.used / 1000)}s of ${Math.ceil(input.limit / 1000)}s`;
	return input.stage === 0.9
		? `Urgent budget notice: ${percentage}% used (${basis}). Stop exploring now. Finish the highest-value remaining work and return the required final result before the limit is reached.`
		: `Budget notice: ${percentage}% used (${basis}). Converge now: stop broad exploration, prioritize the required result, and reserve enough budget to validate and report it.`;
}
