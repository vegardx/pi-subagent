import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
	type ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
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
import { createSubagentService, RetryBackoffError } from "../src/service.js";

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
		attemptRuntimeMs: 30_000,
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
		displayName: "Worker",
		source: agentDigest.canonicalPath,
		sha256: agentDigest.sha256,
		defaultModel: model,
		allowedModels: ["github-copilot/gpt-5.6-luna:low"],
		tools: ["read"],
		preloadSkills: [],
		contextScopes: [],
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
		preloadSkills: [],
		contextScopes: [],
		workspace: { mode: "read-only", cwd: repository },
		limits,
	};
	return { root, repository, agent, request };
}

function result(runId: string, status: RunResult["status"]): RunResult {
	const failures: Partial<
		Record<RunResult["status"], NonNullable<RunResult["failure"]>>
	> = {
		failed: {
			code: "timeout",
			origin: "service",
			retry: "manual",
			message: "test failure",
			guidance: "retry manually",
		},
		cancelled: {
			code: "cancellation",
			origin: "operator",
			retry: "never",
			message: "test cancellation",
			guidance: "start a new run",
		},
		interrupted: {
			code: "seat-interruption",
			origin: "operator",
			retry: "resume",
			message: "test interruption",
			guidance: "resume",
		},
		"cleanup-blocked": {
			code: "sandbox-cleanup",
			origin: "sandbox",
			retry: "reconcile",
			message: "test cleanup block",
			guidance: "reconcile",
		},
	};
	return {
		runId,
		status,
		...(failures[status] ? { failure: failures[status] } : {}),
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: 0,
		},
		usageComplete: true,
		runtimeMs: 100,
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
	const agentDir = path.join(data.root, "agent");
	await mkdir(agentDir, { recursive: true });
	const service = await createSubagentService({
		root: path.join(data.root, "state"),
		agentDir,
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

async function reopenService(data: Awaited<ReturnType<typeof serviceFor>>) {
	return createSubagentService({
		root: path.join(data.root, "state"),
		agentDir: path.join(data.root, "agent"),
		agents: new Map([[data.agent.name, data.agent]]),
		modelRuntime: {} as ModelRuntime,
		capacity: await createVmCapacityManager({
			root: path.join(data.root, "restart-capacity"),
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
		const observations: string[] = [];
		const unsubscribe = data.service.subscribe((event) => {
			observations.push(`${event.runId}:${event.status}`);
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
		expect((await client.logs(first.runId)).events).toHaveLength(1);
		expect(
			(await data.service.runLogs(first.runId, { tail: 1 })).events,
		).toHaveLength(1);
		expect((await data.service.inspectRun(first.runId)).plan.agentPrompt).toBe(
			"worker prompt",
		);
		const page = await data.service.listRuns({
			repositoryRoot: await realpath(data.repository),
			limit: 1,
		});
		expect(page.total).toBe(1);
		expect(page.runs[0]).toMatchObject({
			runId: first.runId,
			agentDisplayName: "Worker",
			status: "completed",
			workspaceMode: "read-only",
		});
		expect((await client.listRuns()).runs).toHaveLength(1);
		expect((await data.service.listRuns({ search: "worker" })).total).toBe(1);
		expect((await data.service.listRuns({ search: "missing" })).total).toBe(0);
		await expect(data.service.listRuns({ cursor: "invalid" })).rejects.toThrow(
			"invalid run list cursor",
		);
		expect(observations).toContain(`${first.runId}:active`);
		expect(observations).toContain(`${first.runId}:completed`);
		unsubscribe();
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
			agentDir: path.join(data.root, "agent"),
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
		expect((await restartedClient.release(first.runId)).status).toBe(
			"completed",
		);
		expect((await restartedClient.release(first.runId)).status).toBe(
			"completed",
		);
	});

	it("restores persisted handoff metadata after restart", async () => {
		const data = await fixture("handoff-recovery");
		const agent = { ...data.agent, workspaceModes: ["worktree" as const] };
		let expectedHandoffCommit = "";
		data.request.workspace = { mode: "worktree", cwd: data.repository };
		const service = await createSubagentService({
			root: path.join(data.root, "state"),
			agentDir: path.join(data.root, "agent"),
			agents: new Map([[agent.name, agent]]),
			modelRuntime: {} as ModelRuntime,
			capacity: await createVmCapacityManager({
				root: path.join(data.root, "capacity"),
				maxSlots: 1,
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
			executeAttempt: async (input) => {
				if (!input.worktree) throw new Error("worktree missing");
				expectedHandoffCommit = input.worktree.baselineHead;
				const handoff = {
					...input.worktree,
					handoffCommit: expectedHandoffCommit,
				};
				await writeFile(
					input.worktree.recordPath,
					`${JSON.stringify(handoff, null, 2)}\n`,
				);
				const execution = {
					result: {
						...result(input.plan.runId, "completed"),
						workspaceCleanup: "proved" as const,
					},
					output: "handoff",
					sessionFile: undefined,
					handoff,
					structuredOutput: undefined,
					error: undefined,
				};
				await input.journal.append("attempt-completed", {});
				await input.journal.writeSnapshot(execution);
				return execution;
			},
		});
		const ownerId = "owner-handoff";
		const client = service.forOwner({ id: ownerId });
		const preflight = await client.preflight({
			...data.request,
			operationId: "operation-handoff",
		});
		const receipt = await client.launch(
			preflight.preflightId,
			preflight.identitySha256,
		);
		await client.wait(receipt.runId);
		await service.shutdown();
		const restarted = await createSubagentService({
			root: path.join(data.root, "state"),
			agentDir: path.join(data.root, "agent"),
			agents: new Map(),
			modelRuntime: {} as ModelRuntime,
			capacity: await createVmCapacityManager({
				root: path.join(data.root, "capacity"),
				maxSlots: 1,
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
		const restartedClient = restarted.forOwner({ id: ownerId });
		expect((await restartedClient.wait(receipt.runId)).handoff).toMatchObject({
			handoffCommit: expectedHandoffCommit,
		});
		await restartedClient.release(receipt.runId);
		await restarted.shutdown();
	});

	it("keeps execution dependencies lazy for metadata inspection", async () => {
		const data = await fixture("lazy-metadata");
		let loads = 0;
		const service = await createSubagentService({
			root: path.join(data.root, "state"),
			agentDir: path.join(data.root, "agent"),
			agents: new Map([[data.agent.name, data.agent]]),
			resolveModel: async (model) => model,
			async loadExecution() {
				loads++;
				return {
					modelRuntime: {} as ModelRuntime,
					capacity: await createVmCapacityManager({
						root: path.join(data.root, "capacity"),
						maxSlots: 1,
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
				};
			},
		});
		expect((await service.listRuns()).runs).toEqual([]);
		expect(loads).toBe(0);
		await service.forOwner({ id: "owner-lazy" }).preflight(data.request);
		expect(loads).toBe(1);
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

	it("pins and prunes complete owner-bound run graphs", async () => {
		const data = await serviceFor("retention", async (input) => {
			await input.journal.append("attempt-completed", { status: "completed" });
			const execution = {
				result: result(input.plan.runId, "completed"),
				output: "done",
				sessionFile: undefined,
				handoff: undefined,
				structuredOutput: undefined,
				error: undefined,
			};
			await input.journal.writeSnapshot(execution);
			return execution;
		});
		const client = data.service.forOwner({ id: "owner-retention" });
		const preflight = await client.preflight({
			...data.request,
			operationId: "operation-retention",
		});
		const receipt = await client.launch(
			preflight.preflightId,
			preflight.identitySha256,
		);
		await client.wait(receipt.runId);
		await client.pin(receipt.runId, "keep for review");
		const protectedReport = await data.service.prune({
			dryRun: false,
			maxAgeMs: 0,
		});
		expect(
			protectedReport.protected.find((run) => run.runId === receipt.runId)
				?.reasons,
		).toContain("pinned");
		expect(await client.unpin(receipt.runId)).toBe(true);
		const pruned = await data.service.prune({ dryRun: false, maxAgeMs: 0 });
		expect(pruned.pruned.map((run) => run.runId)).toContain(receipt.runId);
		await expect(client.status(receipt.runId)).rejects.toThrow("run not found");
	});

	it("projects explicit global context files into attempts", async () => {
		let observedContext = "";
		const data = await serviceFor("context-files", async (input) => {
			observedContext = JSON.stringify(input.contextFiles);
			return {
				result: result(input.plan.runId, "completed"),
				output: "done",
				sessionFile: undefined,
				handoff: undefined,
				structuredOutput: undefined,
				error: undefined,
			};
		});
		await writeFile(
			path.join(data.root, "agent", "AGENTS.md"),
			"SERVICE_CONTEXT_MARKER\n",
		);
		const client = data.service.forOwner({ id: "owner-context" });
		const preflight = await client.preflight({
			...data.request,
			operationId: "operation-context",
			contextScopes: ["global"],
		});
		expect(preflight.launchPlan.contextScopes).toEqual(["global"]);
		expect(
			preflight.launchPlan.resources.some(
				(resource) => resource.kind === "context",
			),
		).toBe(true);
		const receipt = await client.launch(
			preflight.preflightId,
			preflight.identitySha256,
		);
		await client.wait(receipt.runId);
		expect(observedContext).toContain("SERVICE_CONTEXT_MARKER");
	});

	it("projects an authorized parent session for fork context", async () => {
		let observedFork = "";
		const data = await serviceFor("fork", async (input) => {
			observedFork = JSON.stringify(input.forkContext?.messages ?? []);
			return {
				result: result(input.plan.runId, "completed"),
				output: "done",
				sessionFile: undefined,
				handoff: undefined,
				structuredOutput: undefined,
				error: undefined,
			};
		});
		const parent = SessionManager.create(
			data.repository,
			path.join(data.root, "parent-sessions"),
		);
		parent.appendMessage({
			role: "user",
			content: [{ type: "text", text: "SERVICE_PARENT_MARKER" }],
			timestamp: Date.now(),
		});
		const parentSessionFile = parent.getSessionFile();
		const parentHeader = parent.getHeader();
		if (!parentSessionFile || !parentHeader) {
			throw new Error("parent session file missing");
		}
		await writeFile(
			parentSessionFile,
			`${[parentHeader, ...parent.getEntries()]
				.map((entry) => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		const client = data.service.forOwner({
			id: "owner-fork",
			parentSessionId: parent.getSessionId(),
			parentSessionFile,
		});
		const preflight = await client.preflight({
			...data.request,
			operationId: "operation-fork",
			contextMode: "fork",
		});
		expect(preflight.launchPlan.forkContext?.messageIds).toHaveLength(1);
		const receipt = await client.launch(
			preflight.preflightId,
			preflight.identitySha256,
		);
		await client.wait(receipt.runId);
		expect(observedFork).toContain("SERVICE_PARENT_MARKER");
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
		expect((await client.listRuns()).runs[0]?.controllable).toBe(true);
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
		expect((await client.listRuns()).runs[0]?.controllable).toBe(false);
		expect(
			await client.steer(receipt.runId, {
				operationId: "control-missed",
				text: "late",
			}),
		).toMatchObject({ state: "missed" });
	});

	it("retries a recovered dynamic agent with remaining budgets", async () => {
		const data = await serviceFor("retry", async (input) => {
			const execution = {
				result: result(input.plan.runId, "failed"),
				output: "failed",
				sessionFile: undefined,
				handoff: undefined,
				structuredOutput: undefined,
				error: "transient",
			};
			await input.journal.append("attempt-failed", { status: "failed" });
			await input.journal.writeSnapshot(execution);
			return execution;
		});
		const client = data.service.forOwner({ id: "owner-a" });
		const preflight = await client.preflight(data.request);
		const initial = await client.launch(
			preflight.preflightId,
			preflight.identitySha256,
		);
		expect((await client.wait(initial.runId)).result.status).toBe("failed");
		await data.service.shutdown();
		let retryRuntimeMs = 0;
		const restarted = await createSubagentService({
			root: path.join(data.root, "state"),
			agentDir: path.join(data.root, "agent"),
			agents: new Map(),
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
			executeAttempt: async (input) => {
				retryRuntimeMs = input.plan.limits.runtimeMs;
				return {
					result: result(input.plan.runId, "completed"),
					output: input.agent.prompt,
					sessionFile: undefined,
					handoff: undefined,
					structuredOutput: undefined,
					error: undefined,
				};
			},
		});
		const restartedClient = restarted.forOwner({ id: "owner-a" });
		const retry = await restartedClient.retry(initial.runId);
		expect(retry.attemptId).not.toBe(initial.attemptId);
		expect((await restartedClient.wait(initial.runId)).output).toBe(
			"worker prompt",
		);
		expect(retryRuntimeMs).toBe(data.request.limits.runtimeMs - 100);
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

	it("enforces exponential backoff for transient failures", async () => {
		const data = await serviceFor("retry-backoff", async (input) => {
			const execution = {
				result: {
					...result(input.plan.runId, "failed"),
					failure: {
						code: "provider-transient" as const,
						origin: "provider" as const,
						retry: "backoff" as const,
						message: "status 429 rate limit",
						guidance: "wait before retry",
						retryAfterMs: 300_000,
					},
				},
				output: "failed",
				sessionFile: undefined,
				handoff: undefined,
				structuredOutput: undefined,
				error: "status 429 rate limit",
			};
			await input.journal.append("attempt-failed", { status: "failed" });
			await input.journal.writeSnapshot(execution);
			return execution;
		});
		const client = data.service.forOwner({ id: "owner-backoff" });
		const preflight = await client.preflight({
			...data.request,
			operationId: "operation-backoff",
		});
		const receipt = await client.launch(
			preflight.preflightId,
			preflight.identitySha256,
		);
		await client.wait(receipt.runId);
		await expect(client.retry(receipt.runId)).rejects.toBeInstanceOf(
			RetryBackoffError,
		);
		const summary = (await client.listRuns()).runs[0];
		expect(summary?.retryable).toBe(true);
		expect(summary?.retryAt).toBeDefined();
	});

	it("resumes an interrupted session as a fresh attempt", async () => {
		let attempts = 0;
		let resumedRuntimeMs = 0;
		let retainedSession = "";
		let dataRoot = "";
		const data = await serviceFor("resume", async (input) => {
			attempts++;
			if (attempts === 2) resumedRuntimeMs = input.plan.limits.runtimeMs;
			if (attempts === 1) {
				const manager = SessionManager.create(
					"/workspace",
					path.join(dataRoot, "state", "sessions", "retained"),
				);
				manager.appendMessage({
					role: "user",
					content: [{ type: "text", text: "resume fixture" }],
					timestamp: Date.now(),
				});
				const header = manager.getHeader();
				retainedSession = manager.getSessionFile() ?? "";
				if (!header || !retainedSession) {
					throw new Error("retained session fixture missing");
				}
				await writeFile(
					retainedSession,
					`${[header, ...manager.getEntries()]
						.map((entry) => JSON.stringify(entry))
						.join("\n")}\n`,
				);
				await input.journal.append("session-started", {
					sessionId: manager.getSessionId(),
					sessionFile: retainedSession,
				});
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
		expect(resumedRuntimeMs).toBe(data.request.limits.runtimeMs - 100);
	});

	it("abandons an interrupted run and removes recovery authority", async () => {
		const data = await serviceFor("abandon", async (input) => ({
			result: result(input.plan.runId, "interrupted"),
			output: "partial output",
			sessionFile: "/retained/session.jsonl",
			handoff: undefined,
			structuredOutput: { partial: true },
			error: "interrupted",
		}));
		const client = data.service.forOwner({ id: "owner-abandon" });
		const preflight = await client.preflight({
			...data.request,
			operationId: "operation-abandon",
		});
		const receipt = await client.launch(
			preflight.preflightId,
			preflight.identitySha256,
		);
		expect((await client.wait(receipt.runId)).result.status).toBe(
			"interrupted",
		);
		const before = (await client.listRuns()).runs[0];
		expect(before?.availableActions).toContain("abandon");
		const abandoned = await client.abandon(receipt.runId);
		expect(abandoned.status).toBe("abandoned");
		const terminal = await client.wait(receipt.runId);
		expect(terminal).toMatchObject({
			result: {
				status: "abandoned",
				failure: {
					code: "operator-abandoned",
					origin: "operator",
					retry: "never",
				},
			},
			output: "",
			sessionFile: undefined,
			structuredOutput: undefined,
		});
		await expect(client.resume(receipt.runId)).rejects.toThrow(
			"run is not resumable",
		);
		const after = (await client.listRuns()).runs[0];
		expect(after?.requiresAttention).toBe(false);
		expect(after?.availableActions).toEqual(["pin"]);
		expect((await client.logs(receipt.runId)).events.at(-1)?.type).toBe(
			"run-abandoned",
		);
		await data.service.shutdown();
		const restarted = await reopenService(data);
		const recovered = await restarted
			.forOwner({ id: "owner-abandon" })
			.status(receipt.runId);
		expect(recovered.status).toBe("abandoned");
		expect(recovered.result?.sessionFile).toBeUndefined();
	});

	it("abandons an interrupted run that never started a sandbox or session", async () => {
		const data = await serviceFor("abandon-not-started", async (input) => ({
			result: {
				...result(input.plan.runId, "interrupted"),
				sandboxCleanup: "not-needed",
			},
			output: "",
			sessionFile: undefined,
			handoff: undefined,
			structuredOutput: undefined,
			error: "interrupted before sandbox start",
		}));
		const client = data.service.forOwner({ id: "owner-abandon-not-started" });
		const preflight = await client.preflight({
			...data.request,
			operationId: "operation-abandon-not-started",
		});
		const receipt = await client.launch(
			preflight.preflightId,
			preflight.identitySha256,
		);
		await client.wait(receipt.runId);
		expect((await client.listRuns()).runs[0]?.availableActions).toEqual([
			"abandon",
		]);
		expect((await client.abandon(receipt.runId)).status).toBe("abandoned");
	});

	it("does not abandon cleanup-blocked runs", async () => {
		const data = await serviceFor("abandon-blocked", async (input) => ({
			result: {
				...result(input.plan.runId, "cleanup-blocked"),
				sandboxCleanup: "unknown",
			},
			output: "",
			sessionFile: undefined,
			handoff: undefined,
			structuredOutput: undefined,
			error: "cleanup blocked",
		}));
		const client = data.service.forOwner({ id: "owner-abandon-blocked" });
		const preflight = await client.preflight({
			...data.request,
			operationId: "operation-abandon-blocked",
		});
		const receipt = await client.launch(
			preflight.preflightId,
			preflight.identitySha256,
		);
		await client.wait(receipt.runId);
		await expect(client.abandon(receipt.runId)).rejects.toThrow(
			"only an interrupted run",
		);
		expect((await client.listRuns()).runs[0]?.availableActions).toEqual([
			"reconcile",
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
			agentDir: path.join(data.root, "agent"),
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

	it("recovers an exactly matched retained session during reconciliation", async () => {
		const data = await serviceFor("session-evidence");
		const ownerId = "owner-session-evidence";
		const preflight = await data.service.forOwner({ id: ownerId }).preflight({
			...data.request,
			operationId: "operation-session-evidence",
		});
		const stateRoot = path.join(data.root, "state");
		await (
			await RunRecordStore.open(path.join(stateRoot, "run-records"))
		).create(
			ownerId,
			preflight.launchPlan,
			await preflightWorkspace(data.request.workspace),
		);
		const manager = SessionManager.create(
			"/workspace",
			path.join(stateRoot, "sessions", preflight.launchPlan.attemptId),
		);
		manager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "session evidence" }],
			timestamp: Date.now(),
		});
		const header = manager.getHeader();
		const sessionFile = manager.getSessionFile();
		if (!header || !sessionFile) throw new Error("session evidence missing");
		await writeFile(
			sessionFile,
			`${[header, ...manager.getEntries()]
				.map((entry) => JSON.stringify(entry))
				.join("\n")}\n`,
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
		await journal.append("session-started", {
			sessionId: manager.getSessionId(),
			sessionFile,
		});
		await lease.release();
		await data.service.shutdown();
		const restarted = await createSubagentService({
			root: stateRoot,
			agentDir: path.join(data.root, "agent"),
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
		const reconciled = await restarted
			.forOwner({ id: ownerId })
			.reconcile(preflight.launchPlan.runId);
		expect(reconciled.run.status).toBe("interrupted");
		expect(reconciled.run.result?.sessionFile).toBe(
			await realpath(sessionFile),
		);
		expect(reconciled.run.result?.result.failure).toMatchObject({
			code: "seat-interruption",
			retry: "resume",
		});
	});

	it("terminates only an exactly matched stale QEMU identity", async () => {
		for (const matching of [true, false]) {
			const data = await serviceFor(`process-identity-${matching}`);
			const ownerId = `owner-process-${matching}`;
			const preflight = await data.service.forOwner({ id: ownerId }).preflight({
				...data.request,
				operationId: `operation-process-${matching}`,
			});
			const stateRoot = path.join(data.root, "state");
			await (
				await RunRecordStore.open(path.join(stateRoot, "run-records"))
			).create(
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
			const recordedIdentity = {
				pid: 42_424,
				startedAtMs: 123_000,
				commandSha256: "b".repeat(64),
			};
			await journal.append("sandbox-started", {
				hostPid: recordedIdentity.pid,
				hostProcessIdentity: recordedIdentity,
			});
			await lease.release();
			await data.service.shutdown();
			let terminated = 0;
			const restarted = await createSubagentService({
				root: stateRoot,
				agentDir: path.join(data.root, "agent"),
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
				processController: {
					observe: async () => ({
						state: "present" as const,
						identity: matching
							? recordedIdentity
							: { ...recordedIdentity, startedAtMs: 124_000 },
					}),
					terminate: async () => {
						terminated++;
						return "absent" as const;
					},
				},
			});
			const reconciled = await restarted
				.forOwner({ id: ownerId })
				.reconcile(preflight.launchPlan.runId);
			expect(reconciled.sandboxProcess).toBe(matching ? "absent" : "unknown");
			expect(reconciled.run.status).toBe(
				matching ? "failed" : "cleanup-blocked",
			);
			expect(terminated).toBe(matching ? 1 : 0);
		}
	});

	it("preserves resumability when the owning seat shuts down", async () => {
		let observedReason: unknown;
		const data = await serviceFor(
			"seat-shutdown",
			(input) =>
				new Promise((resolve) => {
					input.signal?.addEventListener(
						"abort",
						() => {
							observedReason = input.signal?.reason;
							resolve({
								result: result(input.plan.runId, "interrupted"),
								output: "interrupted",
								sessionFile: "/retained-session.jsonl",
								handoff: undefined,
								structuredOutput: undefined,
								error: "seat shutdown",
							});
						},
						{ once: true },
					);
				}),
		);
		const client = data.service.forOwner({ id: "owner-seat" });
		const preflight = await client.preflight({
			...data.request,
			operationId: "operation-seat-shutdown",
		});
		const receipt = await client.launch(
			preflight.preflightId,
			preflight.identitySha256,
		);
		await data.service.shutdown();
		expect(observedReason).toBe("seat-shutdown");
		expect((await client.status(receipt.runId)).status).toBe("interrupted");
	});

	it("interrupts an active attempt", async () => {
		let observedReason: unknown;
		const data = await serviceFor("interrupt", async (input) => {
			await new Promise<void>((resolve) => {
				if (input.signal?.aborted) resolve();
				else
					input.signal?.addEventListener("abort", () => resolve(), {
						once: true,
					});
			});
			observedReason = input.signal?.reason;
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
		expect(observedReason).toBe("caller-interrupt");
	});
});
