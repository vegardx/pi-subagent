import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
	CONTRACT_REVISION,
	isRunResult,
	RunResultSchema,
	SUBAGENT_RUNTIME_CONTRACT,
	SubagentRuntimeContractSchema,
} from "../src/contracts.js";

describe("runtime contracts", () => {
	it("publishes an exact current revision without unimplemented features", () => {
		expect(
			Value.Check(SubagentRuntimeContractSchema, SUBAGENT_RUNTIME_CONTRACT),
		).toBe(true);
		expect(SUBAGENT_RUNTIME_CONTRACT.contractRevision).toBe(CONTRACT_REVISION);
		expect(SUBAGENT_RUNTIME_CONTRACT.features).toEqual({
			nativeSessionBackend: true,
			gondolinSandbox: true,
			background: false,
			survivesSeatExit: false,
			steering: false,
			followUp: false,
			structuredOutput: false,
			preflight: true,
			idempotentLaunch: false,
			resume: false,
			worktrees: true,
			publicNetworkEgress: true,
			explicitResources: true,
			ambientExtensionsControl: true,
		});
	});

	it("rejects incompatible and extended runtime contracts", () => {
		expect(
			Value.Check(SubagentRuntimeContractSchema, {
				...SUBAGENT_RUNTIME_CONTRACT,
				contractRevision: CONTRACT_REVISION + 1,
			}),
		).toBe(false);
		expect(
			Value.Check(SubagentRuntimeContractSchema, {
				...SUBAGENT_RUNTIME_CONTRACT,
				legacy: true,
			}),
		).toBe(false);
	});

	it("validates bounded terminal result shapes", () => {
		const result = {
			runId: "run_abc123",
			status: "completed",
			usage: {
				input: 1,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 3,
				cost: 0,
			},
			usageComplete: true,
			sandboxCleanup: "proved",
			workspaceCleanup: "not-needed",
			truncated: false,
		};
		expect(isRunResult(result)).toBe(true);
		expect(
			isRunResult({
				...result,
				usage: { ...result.usage, input: -1 },
			}),
		).toBe(false);
		expect(isRunResult({ ...result, workspaceCleanup: "retained" })).toBe(
			false,
		);
		expect(isRunResult({ ...result, status: "cleanup-blocked" })).toBe(false);
		expect(Value.Check(RunResultSchema, result)).toBe(true);
	});
});
