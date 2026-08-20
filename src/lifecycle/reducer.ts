import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import {
	type CleanupOutcome,
	CleanupOutcomeSchema,
	type RunStatus,
	RunStatusSchema,
} from "../contracts.js";

export const RunTransitionEventSchema = Type.Union([
	Type.Object(
		{ type: Type.Literal("activate") },
		{ additionalProperties: false },
	),
	Type.Object(
		{ type: Type.Literal("begin-stop") },
		{ additionalProperties: false },
	),
	Type.Object(
		{
			type: Type.Literal("complete"),
			sandboxCleanup: CleanupOutcomeSchema,
			workspaceCleanup: CleanupOutcomeSchema,
		},
		{ additionalProperties: false },
	),
	Type.Object({ type: Type.Literal("fail") }, { additionalProperties: false }),
	Type.Object(
		{ type: Type.Literal("cancel") },
		{ additionalProperties: false },
	),
	Type.Object(
		{ type: Type.Literal("interrupt") },
		{ additionalProperties: false },
	),
	Type.Object(
		{ type: Type.Literal("cleanup-blocked") },
		{ additionalProperties: false },
	),
	Type.Object({ type: Type.Literal("retry") }, { additionalProperties: false }),
	Type.Object(
		{ type: Type.Literal("resume") },
		{ additionalProperties: false },
	),
	Type.Object(
		{
			type: Type.Literal("abandon"),
			sandboxCleanup: CleanupOutcomeSchema,
			workspaceCleanup: CleanupOutcomeSchema,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			type: Type.Literal("cleanup-proved"),
			terminalStatus: Type.Union([
				Type.Literal("completed"),
				Type.Literal("failed"),
				Type.Literal("cancelled"),
				Type.Literal("abandoned"),
				Type.Literal("interrupted"),
			]),
			sandboxCleanup: CleanupOutcomeSchema,
			workspaceCleanup: CleanupOutcomeSchema,
		},
		{ additionalProperties: false },
	),
]);
export type RunTransitionEvent = Static<typeof RunTransitionEventSchema>;

export class InvalidRunTransitionError extends Error {
	readonly current: RunStatus;
	readonly event: RunTransitionEvent["type"];

	constructor(current: RunStatus, event: RunTransitionEvent["type"]) {
		super(`invalid run transition: ${current} + ${event}`);
		this.name = "InvalidRunTransitionError";
		this.current = current;
		this.event = event;
	}
}

function cleanupProved(
	sandbox: CleanupOutcome,
	workspace: CleanupOutcome,
): boolean {
	return (
		(sandbox === "proved" || sandbox === "not-needed") &&
		(workspace === "proved" || workspace === "not-needed")
	);
}

function invalid(current: RunStatus, event: RunTransitionEvent): never {
	throw new InvalidRunTransitionError(current, event.type);
}

export function transitionRunStatus(
	current: RunStatus,
	event: RunTransitionEvent,
): RunStatus {
	switch (current) {
		case "queued":
			return event.type === "activate" ? "active" : invalid(current, event);
		case "active":
			switch (event.type) {
				case "begin-stop":
					return "stopping";
				case "complete":
					return cleanupProved(event.sandboxCleanup, event.workspaceCleanup)
						? "completed"
						: "cleanup-blocked";
				case "fail":
					return "failed";
				case "interrupt":
					return "interrupted";
				case "cleanup-blocked":
					return "cleanup-blocked";
				default:
					return invalid(current, event);
			}
		case "stopping":
			if (event.type === "cancel") return "cancelled";
			if (event.type === "cleanup-blocked") return "cleanup-blocked";
			return invalid(current, event);
		case "failed":
			return event.type === "retry" ? "queued" : invalid(current, event);
		case "interrupted":
			if (event.type === "resume") return "queued";
			if (event.type === "abandon") {
				return cleanupProved(event.sandboxCleanup, event.workspaceCleanup)
					? "abandoned"
					: invalid(current, event);
			}
			return invalid(current, event);
		case "cleanup-blocked":
			if (event.type !== "cleanup-proved") return invalid(current, event);
			return cleanupProved(event.sandboxCleanup, event.workspaceCleanup)
				? event.terminalStatus
				: "cleanup-blocked";
		case "completed":
		case "cancelled":
		case "abandoned":
			return invalid(current, event);
	}
}

export function isRunStatus(value: unknown): value is RunStatus {
	return Value.Check(RunStatusSchema, value);
}
