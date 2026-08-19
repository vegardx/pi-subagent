import { describe, expect, it } from "vitest";
import type { SubagentRequest } from "../src/launch-contracts.js";
import {
	type AgentDefinition,
	compileLaunchPlan,
	PreflightError,
} from "../src/preflight/compile.js";

const a = "a".repeat(64);
const b = "b".repeat(64);
const limits = {
	runtimeMs: 60_000,
	tokens: 100_000,
	cost: 10,
	outputBytes: 1024 * 1024,
	workspaceWriteBytes: 128 * 1024 * 1024,
	retries: 1,
	resumes: 1,
};
const model = {
	provider: "github-copilot",
	id: "gpt-5.6-luna",
	thinking: "low" as const,
};
const request: SubagentRequest = {
	operationId: "operation-1",
	agent: "worker",
	task: {
		goal: "Implement it",
		context: [],
		instructions: ["Run tests"],
	},
	contextMode: "fresh",
	model,
	tools: ["write", "read"],
	skills: ["typescript"],
	workspace: { mode: "worktree", cwd: "/repo" },
	limits,
};
const agent: AgentDefinition = {
	name: "worker",
	source: "/agents/worker.md",
	sha256: a,
	defaultModel: model,
	allowedModels: ["github-copilot/gpt-5.6-luna:low"],
	tools: ["read", "write", "bash"],
	skills: ["typescript"],
	workspaceModes: ["worktree"],
	limitCeiling: { ...limits },
};
const resources = [
	{
		kind: "skill" as const,
		name: "typescript",
		source: "/skills/typescript",
		sha256: b,
	},
	{
		kind: "tool" as const,
		name: "write",
		source: "<builtin:write>",
		sha256: b,
	},
	{ kind: "agent" as const, name: "worker", source: agent.source, sha256: a },
	{ kind: "tool" as const, name: "read", source: "<builtin:read>", sha256: a },
];
const workspace = {
	mode: "worktree" as const,
	hostPathSha256: a,
	baselineSha256: b,
};
const sandbox = {
	packageVersion: "0.12.0",
	imageSha256: a,
	mountPolicySha256: b,
	networkPolicySha256: a,
	capacityPolicySha256: b,
	memoryBytes: 512 * 1024 * 1024,
	guestDiskBytes: 2 * 1024 * 1024 * 1024,
};

function compile(
	overrides: Partial<Parameters<typeof compileLaunchPlan>[0]> = {},
) {
	return compileLaunchPlan({
		ownerId: "owner-1",
		runId: "run_preflight",
		attemptId: "attempt_preflight",
		request,
		agent,
		resources,
		workspace,
		sandbox,
		resolveModel: async (model) => model,
		...overrides,
	});
}

describe("semantic preflight", () => {
	it("compiles a deterministic immutable launch identity", async () => {
		const first = await compile();
		const second = await compile({
			request: { ...request, tools: [...request.tools].reverse() },
			resources: [...resources].reverse(),
		});
		expect(first.identitySha256).toBe(second.identitySha256);
		expect(first.tools).toEqual(["read", "write"]);
		expect(first.cwd).toBe("/workspace");
		expect(first.network.blockInternalRanges).toBe(true);
	});

	it("rejects capability and limit escalation", async () => {
		await expect(
			compile({ request: { ...request, tools: ["read", "delete-host"] } }),
		).rejects.toThrow("tool exceeds ceiling");
		await expect(
			compile({
				request: {
					...request,
					limits: { ...limits, runtimeMs: limits.runtimeMs + 1 },
				},
			}),
		).rejects.toThrow("limit exceeds ceiling");
	});

	it("rejects missing or drifted provenance", async () => {
		await expect(
			compile({ resources: resources.filter((item) => item.name !== "read") }),
		).rejects.toThrow("missing resource: tool:read");
		await expect(
			compile({
				resources: resources.map((item) =>
					item.kind === "agent" ? { ...item, sha256: b } : item,
				),
			}),
		).rejects.toThrow("agent provenance mismatch");
		await expect(
			compile({
				resources: [
					...resources,
					{
						kind: "tool",
						name: "bash",
						source: "<builtin:bash>",
						sha256: a,
					},
				],
			}),
		).rejects.toThrow("unrequested resource: tool:bash");
	});

	it("rejects model and workspace resolver drift", async () => {
		await expect(
			compile({
				resolveModel: async (model) => ({ ...model, thinking: "medium" }),
			}),
		).rejects.toThrow("model resolver changed exact selection");
		await expect(
			compile({ workspace: { ...workspace, mode: "read-only" } }),
		).rejects.toThrow("workspace resolution mismatch");
	});

	it("uses stable classified preflight failures", async () => {
		await expect(
			compile({ agent: { ...agent, name: "other" } }),
		).rejects.toBeInstanceOf(PreflightError);
	});
});
