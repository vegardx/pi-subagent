import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentLaunchPlan } from "../src/launch-contracts.js";
import { PersistenceCorruptionError } from "../src/persistence/journal.js";
import { RunRecordStore } from "../src/persistence/run-record.js";
import { canonicalSha256 } from "../src/preflight/canonical.js";

const hash = "a".repeat(64);

function root(name: string): string {
	return path.resolve(".pi", "test-run-records", `${name}-${randomUUID()}`);
}

function plan(): AgentLaunchPlan {
	const draft = {
		schema: "pi-subagent-launch" as const,
		contractRevision: 1 as const,
		operationId: "operation",
		ownerId: "owner",
		runId: "run_record",
		attemptId: "attempt_record",
		agent: "worker",
		task: { goal: "goal", context: [], instructions: ["instruction"] },
		contextMode: "fresh" as const,
		model: {
			provider: "github-copilot",
			id: "gpt-5.6-luna",
			thinking: "low" as const,
		},
		cwd: "/workspace" as const,
		tools: ["read"],
		skills: [],
		resources: [
			{
				kind: "agent" as const,
				name: "worker",
				source: "/agent",
				sha256: hash,
			},
		],
		workspace: {
			mode: "read-only" as const,
			hostPathSha256: hash,
			baselineSha256: hash,
		},
		sandbox: {
			backend: "gondolin" as const,
			packageVersion: "0.12.0",
			imageSha256: hash,
			mountPolicySha256: hash,
			networkPolicySha256: hash,
			capacityPolicySha256: hash,
			memoryBytes: 512 * 1024 * 1024,
			guestDiskBytes: 1024,
			workspaceWriteBytes: 0,
		},
		network: {
			mode: "public-egress" as const,
			blockInternalRanges: true as const,
		},
		limits: {
			runtimeMs: 60_000,
			tokens: 1000,
			cost: 1,
			outputBytes: 1024,
			workspaceWriteBytes: 0,
			retries: 0,
			resumes: 0,
		},
	};
	return { ...draft, identitySha256: canonicalSha256(draft) };
}

describe("run record store", () => {
	it("creates, replays, and lists immutable run identities", async () => {
		const store = await RunRecordStore.open(root("basic"));
		const launch = plan();
		const first = await store.create("owner", launch);
		const replay = await store.create("owner", launch);
		expect(replay).toEqual(first);
		expect(await store.list()).toEqual([first]);
	});

	it("rejects conflicting and corrupt identities", async () => {
		const store = await RunRecordStore.open(root("conflict"));
		const launch = plan();
		await store.create("owner", launch);
		await expect(
			store.create("other-owner", { ...launch, ownerId: "other-owner" }),
		).rejects.toThrow();
		await writeFile(path.join(store.root, `${launch.runId}.json`), "{broken");
		await expect(store.read(launch.runId)).rejects.toBeInstanceOf(
			PersistenceCorruptionError,
		);
	});
});
