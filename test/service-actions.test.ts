import { describe, expect, it } from "vitest";
import type { RunStatus } from "../src/contracts.js";
import {
	availableRunActions,
	isRunAction,
	RUN_ACTIONS,
	type RunActionFacts,
} from "../src/service.js";

function facts(
	status: RunStatus,
	overrides: Partial<RunActionFacts> = {},
): RunActionFacts {
	return {
		status,
		pinned: false,
		controllable: false,
		retryable: false,
		retryAvailable: false,
		resumable: false,
		abandonable: false,
		retainedWorktree: false,
		workspaceReleasable: false,
		hasOutput: false,
		...overrides,
	};
}

describe("subagent run action projection", () => {
	it("publishes one exhaustive action catalog", () => {
		expect(new Set(RUN_ACTIONS).size).toBe(RUN_ACTIONS.length);
		for (const action of RUN_ACTIONS) expect(isRunAction(action)).toBe(true);
		expect(isRunAction("release")).toBe(false);
	});

	it("projects one exact action matrix for every run state", () => {
		expect(availableRunActions(facts("queued"))).toEqual([]);
		expect(
			availableRunActions(facts("active", { controllable: true })),
		).toEqual(["steer", "follow-up", "stop"]);
		expect(availableRunActions(facts("active"))).toEqual(["stop"]);
		expect(availableRunActions(facts("stopping"))).toEqual([]);
		expect(availableRunActions(facts("completed"))).toEqual(["pin"]);
		expect(
			availableRunActions(
				facts("failed", { retryable: true, retryAvailable: true }),
			),
		).toEqual(["retry", "pin"]);
		expect(availableRunActions(facts("cancelled"))).toEqual(["pin"]);
		expect(availableRunActions(facts("abandoned"))).toEqual(["pin"]);
		expect(
			availableRunActions(
				facts("interrupted", {
					resumable: true,
					abandonable: true,
					retainedWorktree: true,
				}),
			),
		).toEqual(["resume", "abandon"]);
		expect(
			availableRunActions(
				facts("cleanup-blocked", {
					retainedWorktree: true,
					workspaceReleasable: true,
				}),
			),
		).toEqual(["reconcile", "release-workspace"]);
		expect(
			availableRunActions(
				facts("cleanup-blocked", {
					retainedWorktree: true,
					workspaceReleasable: false,
				}),
			),
		).toEqual(["reconcile"]);
	});

	it("keeps retention and output actions orthogonal", () => {
		expect(
			availableRunActions(
				facts("completed", { pinned: true, hasOutput: true }),
			),
		).toEqual(["unpin", "export-output"]);
		expect(
			availableRunActions(
				facts("interrupted", {
					pinned: true,
					abandonable: false,
				}),
			),
		).toEqual([]);
	});
});
