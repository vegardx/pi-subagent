import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
	AgentLaunchPlanSchema,
	SubagentRequestSchema,
} from "../src/launch-contracts.js";

const hash = "a".repeat(64);
const limits = {
	runtimeMs: 60_000,
	tokens: 100_000,
	cost: 10,
	outputBytes: 1024 * 1024,
	workspaceWriteBytes: 128 * 1024 * 1024,
	retries: 1,
	resumes: 1,
};
const task = {
	goal: "Implement the requested behavior",
	context: ["Repository is trusted"],
	instructions: ["Run the relevant tests"],
};

const request = {
	operationId: "operation-1",
	agent: "worker",
	task,
	contextMode: "fresh",
	model: { provider: "github-copilot", id: "gpt-5.6-luna", thinking: "low" },
	tools: ["read", "write", "edit", "bash"],
	preloadSkills: [],
	contextScopes: [],
	workspace: { mode: "worktree", cwd: "/repo" },
	limits,
};

const plan = {
	schema: "pi-subagent-launch",
	contractRevision: 1,
	operationId: "operation-1",
	ownerId: "owner-1",
	runId: "run_launch",
	attemptId: "attempt_launch",
	agent: "worker",
	task,
	contextMode: "fresh",
	model: { provider: "github-copilot", id: "gpt-5.6-luna", thinking: "low" },
	cwd: "/workspace",
	tools: ["read", "write", "edit", "bash"],
	preloadSkills: [],
	contextScopes: [],
	resources: [
		{
			kind: "agent",
			name: "worker",
			source: "/agents/worker.md",
			sha256: hash,
		},
		{
			kind: "tool",
			name: "read",
			source: "<builtin:read>",
			sha256: hash,
		},
	],
	workspace: {
		mode: "worktree",
		hostPathSha256: hash,
		baselineSha256: hash,
	},
	sandbox: {
		backend: "gondolin",
		packageVersion: "0.12.0",
		imageSha256: hash,
		mountPolicySha256: hash,
		networkPolicySha256: hash,
		capacityPolicySha256: hash,
		memoryBytes: 512 * 1024 * 1024,
		guestDiskBytes: 2 * 1024 * 1024 * 1024,
		workspaceWriteBytes: limits.workspaceWriteBytes,
	},
	network: { mode: "public-egress", blockInternalRanges: true },
	limits,
	identitySha256: hash,
};

describe("launch contracts", () => {
	it("accepts a bounded request and immutable launch plan", () => {
		expect(Value.Check(SubagentRequestSchema, request)).toBe(true);
		expect(Value.Check(AgentLaunchPlanSchema, plan)).toBe(true);
	});

	it("rejects duplicate grants and unknown request fields", () => {
		expect(
			Value.Check(SubagentRequestSchema, {
				...request,
				tools: ["read", "read"],
			}),
		).toBe(false);
		expect(
			Value.Check(SubagentRequestSchema, { ...request, extensions: [] }),
		).toBe(false);
	});

	it("rejects widened limits and weakened network policy", () => {
		expect(
			Value.Check(SubagentRequestSchema, {
				...request,
				limits: { ...limits, runtimeMs: 3_600_001 },
			}),
		).toBe(false);
		expect(
			Value.Check(AgentLaunchPlanSchema, {
				...plan,
				network: { ...plan.network, blockInternalRanges: false },
			}),
		).toBe(false);
	});

	it("rejects incompatible revisions and host cwd projection", () => {
		expect(
			Value.Check(AgentLaunchPlanSchema, { ...plan, contractRevision: 2 }),
		).toBe(false);
		expect(Value.Check(AgentLaunchPlanSchema, { ...plan, cwd: "/repo" })).toBe(
			false,
		);
	});
});
