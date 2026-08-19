import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { RunResult } from "../src/contracts.js";
import type { SubagentRequest } from "../src/launch-contracts.js";
import { AttemptRecordStore } from "../src/persistence/attempt-record.js";
import { RunJournal } from "../src/persistence/journal.js";
import { acquireRunLease } from "../src/persistence/run-lease.js";
import { RunRecordStore } from "../src/persistence/run-record.js";
import { digestFileResource } from "../src/preflight/resources.js";
import { preflightWorkspace } from "../src/preflight/workspace.js";
import { createVmCapacityManager } from "../src/sandbox/capacity.js";
import { createSubagentService } from "../src/service.js";

const execFileAsync = promisify(execFile);
const hash = "a".repeat(64);

async function fixture(name: string) {
	const root = path.join(
		tmpdir(),
		`pi-subagent-service-${name}-${randomUUID()}`,
	);
	const repository = path.join(root, "repository");
	await mkdir(repository, { recursive: true });
	await execFileAsync("git", ["init", "--quiet"], { cwd: repository });
	await execFileAsync("git", ["config", "user.name", "Qualification"], {
		cwd: repository,
	});
	await execFileAsync(
		"git",
		["config", "user.email", "qualification@example.invalid"],
		{ cwd: repository },
	);
	await writeFile(path.join(repository, "file.txt"), "content\n");
	await execFileAsync("git", ["add", "."], { cwd: repository });
	await execFileAsync("git", ["commit", "--quiet", "-m", "initial"], {
		cwd: repository,
	});
	const agentPath = path.join(root, "worker.md");
	await writeFile(agentPath, "worker prompt\n");
	const agentDigest = await digestFileResource(agentPath);
	const limits = {
		runtimeMs: 60_000,
		tokens: 100_000,
		cost: 10,
		outputBytes: 4096,
		workspaceWriteBytes: 0,
		retries: 1,
		resumes: 1,
	};
	const model = {
		provider: "github-copilot",
		id: "gpt-5.6-luna",
		thinking: "low" as const,
	};
	const agent = {
		name: "worker",
		source: agentDigest.canonicalPath,
		sha256: agentDigest.sha256,
		defaultModel: model,
		allowedModels: ["github-copilot/gpt-5.6-luna:low"],
		tools: ["read"],
		skills: [],
		workspaceModes: ["read-only" as const],
		limitCeiling: limits,
		prompt: "worker prompt",
		scope: "global" as const,
	};
	const request: SubagentRequest = {
		operationId: "operation-1",
		agent: "worker",
		task: { goal: "Read", context: [], instructions: ["Return result"] },
		contextMode: "fresh",
		model,
		tools: ["read"],
		skills: [],
		workspace: { mode: "read-only", cwd: repository },
		limits,
	};
	return { root, repository, agent, request };
}

function result(runId: string, status: RunResult["status"]): RunResult {
	return {
		runId,
		status,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: 0,
		},
		usageComplete: true,
		sandboxCleanup: "proved",
		workspaceCleanup: "not-needed",
		truncated: false,
	};
}

async function serviceFor(
	name: string,
	executeAttempt?: Parameters<
		typeof createSubagentService
	>[0]["executeAttempt"],
) {
	const data = await fixture(name);
	const service = await createSubagentService({
		root: path.join(data.root, "state"),
		agents: new Map([[data.agent.name, data.agent]]),
		modelRuntime: {} as ModelRuntime,
		capacity: await createVmCapacityManager({
			root: path.join(data.root, "capacity"),
			maxSlots: 2,
		}),
		sandbox: {
			packageVersion: "0.12.0",
			imageSha256: hash,
			mountPolicySha256: hash,
			networkPolicySha256: hash,
			capacityPolicySha256: hash,
			memoryBytes: 512 * 1024 * 1024,
			guestDiskBytes: 2 * 1024 * 1024 * 1024,
		},
		resolveModel: async (model) => model,
		...(executeAttempt ? { executeAttempt } : {}),
	});
	return { ...data, service };
}

describe("foreground subagent service", () => {
	it("preflights, launches idempotently, waits, and scopes owners", async () => {
		const data = await serviceFor("success", async (input) => {
			await input.journal.append("fake-attempt", {});
			const output = await input.artifactStore.put("done", "text/plain");
			const execution = {
				result: { ...result(input.plan.runId, "completed"), output },
				output: "done",
				sessionFile: "/session.jsonl",
				handoff: undefined,
				structuredOutput: undefined,
				error: undefined,
			};
			await input.journal.writeSnapshot(execution);
			return execution;
		});
		const client = data.service.forOwner({ id: "owner-a" });
		const preflight = await client.preflight(data.request);
		const [first, duplicate] = await Promise.all([
			client.launch(preflight.preflightId, preflight.identitySha256),
			client.launch(preflight.preflightId, preflight.identitySha256),
		]);
		expect(duplicate.runId).toBe(first.runId);
		const completed = await client.wait(first.runId);
		expect(completed.output).toBe("done");
		const outputRef = completed.result.output;
		expect(outputRef).toBeDefined();
		if (!outputRef) throw new Error("output artifact missing");
		expect(
			(await client.exportArtifact(first.runId, outputRef)).content.toString(
				"utf8",
			),
		).toBe("done");
		expect((await client.status(first.runId)).status).toBe("completed");
		expect(await client.logs(first.runId)).toHaveLength(1);
		expect(
			await (
				await AttemptRecordStore.open(
					path.join(data.root, "state", "attempt-records"),
				)
			).list(first.runId),
		).toHaveLength(1);
		await expect(
			data.service.forOwner({ id: "owner-b" }).status(first.runId),
		).rejects.toThrow("run not found");

		const restarted = await createSubagentService({
			root: path.join(data.root, "state"),
			agents: new Map([[data.agent.name, data.agent]]),
			modelRuntime: {} as ModelRuntime,
			capacity: await createVmCapacityManager({
				root: path.join(data.root, "capacity"),
				maxSlots: 2,
			}),
			sandbox: {
				packageVersion: "0.12.0",
				imageSha256: hash,
				mountPolicySha256: hash,
				networkPolicySha256: hash,
				capacityPolicySha256: hash,
				memoryBytes: 512 * 1024 * 1024,
				guestDiskBytes: 2 * 1024 * 1024 * 1024,
			},
			resolveModel: async (model) => model,
		});
		const restartedClient = restarted.forOwner({ id: "owner-a" });
		expect((await restartedClient.status(first.runId)).status).toBe(
			"completed",
		);
		expect((await restartedClient.findByOperation("operation-1"))?.runId).toBe(
			first.runId,
		);
		expect((await restartedClient.wait(first.runId)).output).toBe("done");
	});

	it("rejects workspace drift after preflight", async () => {
		const data = await serviceFor("drift", async (input) => ({
			result: result(input.plan.runId, "completed"),
			output: "unused",
			sessionFile: undefined,
			handoff: undefined,
			structuredOutput: undefined,
			error: undefined,
		}));
		const client = data.service.forOwner({ id: "owner-a" });
		const preflight = await client.preflight(data.request);
		await writeFile(path.join(data.repository, "file.txt"), "changed\n");
		await expect(
			client.launch(preflight.preflightId, preflight.identitySha256),
		).rejects.toThrow("workspace changed after preflight");
	});

	it("delivers ordered idempotent steering and follow-up controls", async () => {
		const delivered: string[] = [];
		let finish = () => {};
		const data = await serviceFor("controls", async (input) => {
			input.registerControl?.({
				async steer(text) {
					delivered.push(`steer:${text}`);
				},
				async followUp(text) {
					delivered.push(`follow:${text}`);
				},
			});
			await new Promise<void>((resolve) => {
				finish = resolve;
			});
			input.registerControl?.(undefined);
			return {
				result: result(input.plan.runId, "completed"),
				output: "done",
				sessionFile: undefined,
				handoff: undefined,
				structuredOutput: undefined,
				error: undefined,
			};
		});
		const client = data.service.forOwner({ id: "owner-a" });
		const preflight = await client.preflight(data.request);
		const receipt = await client.launch(
			preflight.preflightId,
			preflight.identitySha256,
		);
		expect(
			await client.steer(receipt.runId, {
				operationId: "control-steer",
				text: "focus",
			}),
		).toMatchObject({ state: "accepted-by-session" });
		expect(
			await client.followUp(receipt.runId, {
				operationId: "control-follow",
				text: "summarize",
			}),
		).toMatchObject({ state: "accepted-by-session" });
		await client.steer(receipt.runId, {
			operationId: "control-steer",
			text: "focus",
		});
		expect(delivered).toEqual(["steer:focus", "follow:summarize"]);
		finish();
		await client.wait(receipt.runId);
		expect(
			await client.steer(receipt.runId, {
				operationId: "control-missed",
				text: "late",
			}),
		).toMatchObject({ state: "missed" });
	});

	it("retries a classified failed attempt with remaining budgets", async () => {
		let attempts = 0;
		const data = await serviceFor("retry", async (input) => {
			attempts++;
			const status = attempts === 1 ? "failed" : "completed";
			return {
				result: result(input.plan.runId, status),
				output: status,
				sessionFile: undefined,
				handoff: undefined,
				structuredOutput: undefined,
				error: status === "failed" ? "transient" : undefined,
			};
		});
		const client = data.service.forOwner({ id: "owner-a" });
		const preflight = await client.preflight(data.request);
		const initial = await client.launch(
			preflight.preflightId,
			preflight.identitySha256,
		);
		expect((await client.wait(initial.runId)).result.status).toBe("failed");
		const retry = await client.retry(initial.runId);
		expect(retry.attemptId).not.toBe(initial.attemptId);
		expect((await client.wait(initial.runId)).result.status).toBe("completed");
		const history = await (
			await AttemptRecordStore.open(
				path.join(data.root, "state", "attempt-records"),
			)
		).list(initial.runId);
		expect(history.map((attempt) => attempt.kind)).toEqual([
			"initial",
			"retry",
		]);
		expect(history[1]?.parentAttemptId).toBe(initial.attemptId);
	});

	it("resumes an interrupted session as a fresh attempt", async () => {
		let attempts = 0;
		let retainedSession = "";
		let dataRoot = "";
		const data = await serviceFor("resume", async (input) => {
			attempts++;
			if (attempts === 1) {
				retainedSession = path.join(
					dataRoot,
					"state",
					"sessions",
					"retained",
					"session.jsonl",
				);
				await mkdir(path.dirname(retainedSession), { recursive: true });
				await writeFile(retainedSession, "session\n");
			}
			return {
				result: result(
					input.plan.runId,
					attempts === 1 ? "interrupted" : "completed",
				),
				output: "",
				sessionFile: attempts === 1 ? retainedSession : input.resumeSessionFile,
				handoff: undefined,
				structuredOutput: undefined,
				error: attempts === 1 ? "interrupted" : undefined,
			};
		});
		dataRoot = data.root;
		const client = data.service.forOwner({ id: "owner-a" });
		const preflight = await client.preflight(data.request);
		const initial = await client.launch(
			preflight.preflightId,
			preflight.identitySha256,
		);
		expect((await client.wait(initial.runId)).result.status).toBe(
			"interrupted",
		);
		const resumed = await client.resume(initial.runId);
		expect(resumed.attemptId).not.toBe(initial.attemptId);
		expect((await client.wait(initial.runId)).result.status).toBe("completed");
		const history = await (
			await AttemptRecordStore.open(
				path.join(data.root, "state", "attempt-records"),
			)
		).list(initial.runId);
		expect(history.map((attempt) => attempt.kind)).toEqual([
			"initial",
			"resume",
		]);
	});

	it("reconciles a stale pre-terminal run conservatively", async () => {
		const data = await serviceFor("reconcile");
		const ownerId = "owner-a";
		const preflight = await data.service
			.forOwner({ id: ownerId })
			.preflight(data.request);
		const stateRoot = path.join(data.root, "state");
		const records = await RunRecordStore.open(
			path.join(stateRoot, "run-records"),
		);
		await records.create(
			ownerId,
			preflight.launchPlan,
			await preflightWorkspace(data.request.workspace),
		);
		const lease = await acquireRunLease({
			root: path.join(stateRoot, "leases"),
			runId: preflight.launchPlan.runId,
		});
		const journal = await RunJournal.open(
			path.join(stateRoot, "runs"),
			preflight.launchPlan.runId,
			lease,
		);
		await journal.append("attempt-starting", {});
		await lease.release();

		const restarted = await createSubagentService({
			root: stateRoot,
			agents: new Map([[data.agent.name, data.agent]]),
			modelRuntime: {} as ModelRuntime,
			capacity: await createVmCapacityManager({
				root: path.join(data.root, "capacity"),
				maxSlots: 2,
			}),
			sandbox: {
				packageVersion: "0.12.0",
				imageSha256: hash,
				mountPolicySha256: hash,
				networkPolicySha256: hash,
				capacityPolicySha256: hash,
				memoryBytes: 512 * 1024 * 1024,
				guestDiskBytes: 2 * 1024 * 1024 * 1024,
			},
			resolveModel: async (model) => model,
		});
		const client = restarted.forOwner({ id: ownerId });
		expect((await client.status(preflight.launchPlan.runId)).status).toBe(
			"cleanup-blocked",
		);
		const reconciled = await client.reconcile(preflight.launchPlan.runId);
		expect(reconciled.sandboxProcess).toBe("not-started");
		expect(reconciled.workspace).toBe("not-needed");
		expect(reconciled.run.status).toBe("failed");
	});

	it("interrupts an active attempt", async () => {
		const data = await serviceFor("interrupt", async (input) => {
			await new Promise<void>((resolve) => {
				if (input.signal?.aborted) resolve();
				else
					input.signal?.addEventListener("abort", () => resolve(), {
						once: true,
					});
			});
			return {
				result: result(input.plan.runId, "cancelled"),
				output: "",
				sessionFile: undefined,
				handoff: undefined,
				structuredOutput: undefined,
				error: "cancelled",
			};
		});
		const client = data.service.forOwner({ id: "owner-a" });
		const preflight = await client.preflight(data.request);
		const receipt = await client.launch(
			preflight.preflightId,
			preflight.identitySha256,
		);
		expect((await client.interrupt(receipt.runId)).status).toBe("stopping");
		expect((await client.wait(receipt.runId)).result.status).toBe("cancelled");
	});
});
