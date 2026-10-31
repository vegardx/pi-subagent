import { describe, expect, it } from "vitest";
import { classifyAttemptFailure } from "../src/runtime/failure.js";
import { VmCapacityExhaustedError } from "../src/sandbox/capacity.js";

const cleanup = {
	sandboxCleanup: "proved" as const,
	workspaceCleanup: "not-needed" as const,
};

describe("attempt failure classification", () => {
	it.each([
		{
			name: "seat interruption",
			input: {
				error: new Error("aborted"),
				timedOut: false,
				externalAbortReason: "seat-shutdown",
				...cleanup,
			},
			code: "seat-interruption",
			retry: "resume",
		},
		{
			name: "operator cancellation",
			input: {
				error: new Error("aborted"),
				timedOut: false,
				externalAbortReason: "caller-interrupt",
				...cleanup,
			},
			code: "cancellation",
			retry: "never",
		},
		{
			name: "fatal tool timeout",
			input: {
				error: new Error("timeout:1"),
				timedOut: false,
				fatalToolAbort: true,
				...cleanup,
			},
			code: "tool",
			retry: "manual",
		},
		{
			name: "attempt timeout",
			input: { error: new Error("deadline"), timedOut: true, ...cleanup },
			code: "timeout",
			retry: "manual",
		},
		{
			name: "token or cost budget",
			input: {
				error: new Error("attempt usage limit exceeded"),
				timedOut: false,
				...cleanup,
			},
			code: "validation",
			retry: "never",
		},
		{
			name: "provider rate limit",
			input: {
				error: new Error("status 429 rate limit"),
				timedOut: false,
				...cleanup,
			},
			code: "provider-transient",
			retry: "backoff",
		},
		{
			name: "authentication",
			input: {
				error: new Error("status 401 unauthorized"),
				timedOut: false,
				...cleanup,
			},
			code: "authentication",
			retry: "never",
		},
		{
			name: "structured output",
			input: {
				error: new Error("structured output repair exhausted"),
				timedOut: false,
				...cleanup,
			},
			code: "model-output",
			retry: "never",
		},
		{
			name: "exhausted workspace write budget",
			input: {
				error: new Error("command failed"),
				timedOut: false,
				workspaceBudgetExhausted: true,
				...cleanup,
			},
			code: "workspace-budget",
			retry: "never",
		},
		{
			name: "reported workspace write budget refusal",
			input: {
				error: new Error(
					"workspace write budget exceeded: requested=10 remaining=2 limit=12",
				),
				timedOut: false,
				...cleanup,
			},
			code: "workspace-budget",
			retry: "never",
		},
		{
			name: "exhausted VM capacity",
			input: {
				error: new VmCapacityExhaustedError(16, 600_000),
				timedOut: false,
				sandboxCleanup: "not-needed" as const,
				workspaceCleanup: "not-needed" as const,
			},
			code: "capacity",
			retry: "backoff",
		},
		{
			name: "cancelled while waiting for VM capacity",
			input: {
				error: new VmCapacityExhaustedError(16, 600_000),
				timedOut: false,
				externalAbortReason: "caller-interrupt",
				...cleanup,
			},
			code: "cancellation",
			retry: "never",
		},
		{
			name: "cleanup block",
			input: {
				error: new Error("close failed"),
				timedOut: false,
				sandboxCleanup: "blocked" as const,
				workspaceCleanup: "retained" as const,
			},
			code: "sandbox-cleanup",
			retry: "reconcile",
		},
	])("classifies $name", ({ input, code, retry }) => {
		const classified = classifyAttemptFailure(input);
		expect(classified.code).toBe(code);
		expect(classified.retry).toBe(retry);
	});

	it("builds a capacity refusal from its own values, not exception text", () => {
		const error = new VmCapacityExhaustedError(16, 600_000);
		error.message = "host detail that must not be persisted";
		const capacity = classifyAttemptFailure({
			error,
			timedOut: false,
			sandboxCleanup: "not-needed",
			workspaceCleanup: "not-needed",
		});
		expect(capacity).toEqual({
			code: "capacity",
			origin: "service",
			retry: "backoff",
			message: "VM capacity exhausted: 16 slots busy for 600 s",
			guidance: expect.stringContaining("VM slot"),
			retryAfterMs: 30_000,
		});
	});

	it("separates budget exhaustion from generic workspace failures", () => {
		const budget = classifyAttemptFailure({
			error: new Error("command failed"),
			timedOut: false,
			workspaceBudgetExhausted: true,
			...cleanup,
		});
		expect(budget.code).toBe("workspace-budget");
		expect(budget.origin).toBe("workspace");
		expect(budget.message).toContain("Workspace write budget exhausted");
		expect(budget.guidance).toContain("workspaceWriteBytes");
		expect(
			classifyAttemptFailure({
				error: new Error("worktree handoff failed"),
				timedOut: false,
				workspaceBudgetExhausted: false,
				...cleanup,
			}).code,
		).toBe("workspace");
	});

	it("fails unknown errors closed to reconciliation", () => {
		expect(
			classifyAttemptFailure({
				error: new Error("surprising failure"),
				timedOut: false,
				...cleanup,
			}),
		).toMatchObject({ code: "unknown", retry: "reconcile" });
	});
});
