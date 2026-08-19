import { describe, expect, it } from "vitest";
import { classifyAttemptFailure } from "../src/runtime/failure.js";

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
			name: "attempt timeout",
			input: { error: new Error("deadline"), timedOut: true, ...cleanup },
			code: "timeout",
			retry: "manual",
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
