import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import type { RunStatus } from "../src/contracts.js";
import {
	InvalidRunTransitionError,
	isRunStatus,
	type RunTransitionEvent,
	RunTransitionEventSchema,
	transitionRunStatus,
} from "../src/lifecycle/reducer.js";

const statuses: RunStatus[] = [
	"queued",
	"active",
	"stopping",
	"completed",
	"failed",
	"cancelled",
	"interrupted",
	"cleanup-blocked",
];

const events = {
	activate: { type: "activate" },
	beginStop: { type: "begin-stop" },
	complete: {
		type: "complete",
		sandboxCleanup: "proved",
		workspaceCleanup: "proved",
	},
	completeBlocked: {
		type: "complete",
		sandboxCleanup: "proved",
		workspaceCleanup: "retained",
	},
	fail: { type: "fail" },
	cancel: { type: "cancel" },
	interrupt: { type: "interrupt" },
	blockCleanup: { type: "cleanup-blocked" },
	retry: { type: "retry" },
	resume: { type: "resume" },
	cleanupProved: {
		type: "cleanup-proved",
		terminalStatus: "completed",
		sandboxCleanup: "proved",
		workspaceCleanup: "not-needed",
	},
	cleanupStillBlocked: {
		type: "cleanup-proved",
		terminalStatus: "completed",
		sandboxCleanup: "unknown",
		workspaceCleanup: "proved",
	},
} satisfies Record<string, RunTransitionEvent>;

type EventName = keyof typeof events;

const expected = new Map<string, RunStatus>([
	["queued:activate", "active"],
	["active:beginStop", "stopping"],
	["active:complete", "completed"],
	["active:completeBlocked", "cleanup-blocked"],
	["active:fail", "failed"],
	["active:interrupt", "interrupted"],
	["active:blockCleanup", "cleanup-blocked"],
	["stopping:cancel", "cancelled"],
	["stopping:blockCleanup", "cleanup-blocked"],
	["failed:retry", "queued"],
	["interrupted:resume", "queued"],
	["cleanup-blocked:cleanupProved", "completed"],
	["cleanup-blocked:cleanupStillBlocked", "cleanup-blocked"],
]);

describe("run status reducer", () => {
	it("exhaustively accepts only declared status/event pairs", () => {
		for (const status of statuses) {
			for (const [name, event] of Object.entries(events) as Array<
				[EventName, RunTransitionEvent]
			>) {
				const next = expected.get(`${status}:${name}`);
				if (next) {
					expect(transitionRunStatus(status, event)).toBe(next);
				} else {
					expect(() => transitionRunStatus(status, event)).toThrow(
						InvalidRunTransitionError,
					);
				}
			}
		}
	});

	it("rejects unknown event fields", () => {
		expect(
			Value.Check(RunTransitionEventSchema, {
				type: "activate",
				legacy: true,
			}),
		).toBe(false);
	});

	it("recognizes only exact run status values", () => {
		for (const status of statuses) expect(isRunStatus(status)).toBe(true);
		expect(isRunStatus("running")).toBe(false);
		expect(isRunStatus({ status: "active" })).toBe(false);
	});
});
