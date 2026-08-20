import type { Usage } from "../contracts.js";

export const BUDGET_STEERING_STAGES = [0.7, 0.9] as const;
export type BudgetSteeringStage = (typeof BUDGET_STEERING_STAGES)[number];
export type BudgetSteeringTrigger =
	| "tokens"
	| "run-runtime"
	| "attempt-runtime";

export function uncachedTokens(usage: Usage): number {
	return usage.input + usage.output;
}

export function remainingUncachedTokens(limit: number, usage: Usage): number {
	return limit - uncachedTokens(usage);
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
			? `${input.used.toLocaleString()} of ${input.limit.toLocaleString()} uncached input/output tokens`
			: `${Math.ceil(input.used / 1000)}s of ${Math.ceil(input.limit / 1000)}s`;
	return input.stage === 0.9
		? `Urgent budget notice: ${percentage}% used (${basis}). Stop exploring now. Finish the highest-value remaining work and return the required final result before the limit is reached.`
		: `Budget notice: ${percentage}% used (${basis}). Converge now: stop broad exploration, prioritize the required result, and reserve enough budget to validate and report it.`;
}
