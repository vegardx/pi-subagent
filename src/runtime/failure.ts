import type { ClassifiedFailure, CleanupOutcome } from "../contracts.js";

const MAX_MESSAGE_BYTES = 4096;

function boundedMessage(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	const value = raw.trim() || "Unknown attempt failure";
	const bytes = Buffer.from(value, "utf8");
	if (bytes.byteLength <= MAX_MESSAGE_BYTES) return value;
	return bytes
		.subarray(0, MAX_MESSAGE_BYTES)
		.toString("utf8")
		.replace(/�$/u, "");
}

function failure(
	code: ClassifiedFailure["code"],
	origin: ClassifiedFailure["origin"],
	retry: ClassifiedFailure["retry"],
	message: string,
	guidance: string,
	retryAfterMs?: number,
): ClassifiedFailure {
	return {
		code,
		origin,
		retry,
		message,
		guidance,
		...(retryAfterMs === undefined ? {} : { retryAfterMs }),
	};
}

export function classifyAttemptFailure(options: {
	error: unknown;
	timedOut: boolean;
	externalAbortReason?: unknown;
	sandboxCleanup: CleanupOutcome;
	workspaceCleanup: CleanupOutcome;
}): ClassifiedFailure {
	const message = boundedMessage(options.error);
	const normalized = `${
		options.error instanceof Error ? options.error.name : ""
	} ${message}`.toLowerCase();

	if (
		options.sandboxCleanup === "blocked" ||
		options.sandboxCleanup === "unknown"
	) {
		return failure(
			"sandbox-cleanup",
			"sandbox",
			"reconcile",
			message,
			"Reconcile the recorded VM identity before retry, resume, or release.",
		);
	}
	if (
		options.workspaceCleanup === "blocked" ||
		options.workspaceCleanup === "unknown"
	) {
		return failure(
			"workspace",
			"workspace",
			"reconcile",
			message,
			"Inspect and reconcile the retained workspace before continuing.",
		);
	}
	if (options.externalAbortReason === "seat-shutdown") {
		return failure(
			"seat-interruption",
			"operator",
			"resume",
			"Seat shutdown interrupted the active attempt",
			"Resume the retained Pi session in a fresh VM after validation.",
		);
	}
	if (options.externalAbortReason !== undefined) {
		return failure(
			"cancellation",
			"operator",
			"never",
			"The operator cancelled the active attempt",
			"Start a new run if the cancelled task is still required.",
		);
	}
	if (options.timedOut) {
		return failure(
			"timeout",
			"service",
			"manual",
			"Attempt runtime limit exceeded",
			"Inspect partial output and explicitly retry only if repeating the task is safe.",
		);
	}
	if (
		normalized.includes("runleasefenced") ||
		normalized.includes("lease fenced")
	) {
		return failure(
			"lease-loss",
			"persistence",
			"reconcile",
			message,
			"Reconcile ownership and external state before continuing.",
		);
	}
	if (
		normalized.includes("structured output") ||
		normalized.includes("final_answer") ||
		normalized.includes("repair exhausted")
	) {
		return failure(
			"model-output",
			"model",
			"never",
			message,
			"Revise the task or output schema before launching a new run.",
		);
	}
	if (
		normalized.includes("unauthorized") ||
		normalized.includes("authentication") ||
		normalized.includes("api key") ||
		normalized.includes("status 401") ||
		normalized.includes("status 403")
	) {
		return failure(
			"authentication",
			"provider",
			"never",
			message,
			"Repair provider authentication before launching another attempt.",
		);
	}
	if (
		normalized.includes("rate limit") ||
		normalized.includes("status 429") ||
		normalized.includes("status 502") ||
		normalized.includes("status 503") ||
		normalized.includes("status 504") ||
		normalized.includes("econnreset") ||
		normalized.includes("econnrefused") ||
		normalized.includes("etimedout")
	) {
		return failure(
			"provider-transient",
			"provider",
			"backoff",
			message,
			"Wait for the bounded retry delay, then retry within remaining run budgets.",
			1_000,
		);
	}
	if (
		normalized.includes("gondolinsandboxerror") ||
		normalized.includes("sandbox construction") ||
		normalized.includes("vm start") ||
		normalized.includes("qemu")
	) {
		return failure(
			"sandbox-launch",
			"sandbox",
			"backoff",
			message,
			"Retry after the bounded delay only if the qualified sandbox environment remains available.",
			1_000,
		);
	}
	if (
		normalized.includes("worktree") ||
		normalized.includes("workspace") ||
		normalized.includes("handoff")
	) {
		return failure(
			"workspace",
			"workspace",
			"reconcile",
			message,
			"Inspect retained Git state and reconcile or release it before continuing.",
		);
	}
	if (
		normalized.includes("persistence") ||
		normalized.includes("journal") ||
		normalized.includes("snapshot") ||
		normalized.includes("fsync")
	) {
		return failure(
			"persistence",
			"persistence",
			"reconcile",
			message,
			"Preserve the run store and reconcile durable state before continuing.",
		);
	}
	if (
		normalized.includes("changed after preflight") ||
		normalized.includes("identity mismatch") ||
		normalized.includes("projection mismatch") ||
		normalized.includes("resource drift")
	) {
		return failure(
			"resource-drift",
			"service",
			"never",
			message,
			"Create a new preflight after reviewing the changed resource.",
		);
	}
	return failure(
		"unknown",
		"service",
		"reconcile",
		message,
		"Inspect lifecycle evidence and reconcile external state before another attempt.",
	);
}
