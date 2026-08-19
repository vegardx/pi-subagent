import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { type ArtifactExport, ArtifactStore } from "./artifacts/store.js";
import type { ArtifactRef, AttemptId, RunId, RunStatus } from "./contracts.js";
import type {
	AgentLaunchPlan,
	ExactModelRequest,
	ResourceGrant,
	SubagentRequest,
} from "./launch-contracts.js";
import { type JournalEvent, RunJournal } from "./persistence/journal.js";
import { OperationIndex } from "./persistence/operation-index.js";
import { acquireRunLease, type RunLease } from "./persistence/run-lease.js";
import type { DiscoveredAgent } from "./preflight/agents.js";
import { canonicalSha256 } from "./preflight/canonical.js";
import {
	compileLaunchPlan,
	type ResolvedSandbox,
} from "./preflight/compile.js";
import { createExactModelResolver } from "./preflight/models.js";
import { digestFileResource } from "./preflight/resources.js";
import {
	preflightWorkspace,
	type WorkspacePreflight,
} from "./preflight/workspace.js";
import {
	type AttemptExecutionResult,
	runNativeAttempt,
} from "./runtime/attempt.js";
import { createFinalAnswerController } from "./runtime/structured-output.js";
import type { VmCapacityManager } from "./sandbox/capacity.js";
import {
	createAttemptWorktree,
	type WorktreeRecord,
} from "./workspace/worktree.js";

export type OwnerRegistration = {
	id: string;
	parentSessionId?: string;
	workflowRunId?: string;
};

export type SubagentPreflight = {
	preflightId: string;
	identitySha256: string;
	expiresAt: string;
	launchPlan: AgentLaunchPlan;
};

export type RunReceipt = {
	runId: RunId;
	attemptId: AttemptId;
	status: RunStatus;
};

export type RunView = RunReceipt & {
	result?: AttemptExecutionResult;
};

export type SubagentClient = {
	preflight(request: SubagentRequest): Promise<SubagentPreflight>;
	launch(
		preflightId: string,
		expectedIdentitySha256: string,
	): Promise<RunReceipt>;
	status(runId: RunId): Promise<RunView>;
	logs(runId: RunId): Promise<JournalEvent[]>;
	wait(runId: RunId): Promise<AttemptExecutionResult>;
	interrupt(runId: RunId): Promise<RunReceipt>;
	exportArtifact(
		runId: RunId,
		ref: ArtifactRef,
		maxBytes?: number,
	): Promise<ArtifactExport>;
};

export type SubagentService = {
	forOwner(owner: OwnerRegistration): SubagentClient;
};

type PreparedPreflight = SubagentPreflight & {
	ownerId: string;
	requestSha256: string;
	agent: DiscoveredAgent;
	workspace: WorkspacePreflight;
};

type ActiveRun = {
	ownerId: string;
	plan: AgentLaunchPlan;
	journal: RunJournal;
	artifacts: ArtifactStore;
	lease: RunLease;
	abort: AbortController;
	promise: Promise<AttemptExecutionResult>;
	result?: AttemptExecutionResult;
	status: RunStatus;
};

type AttemptExecutor = typeof runNativeAttempt;

const IMPLEMENTED_TOOLS = new Set([
	"read",
	"write",
	"edit",
	"bash",
	"grep",
	"find",
	"ls",
]);

function deterministicIds(ownerId: string, request: SubagentRequest) {
	const identity = canonicalSha256({ ownerId, request });
	return {
		runId: `run_${identity.slice(0, 48)}`,
		attemptId: `attempt_${identity.slice(0, 48)}`,
		requestSha256: canonicalSha256(request),
	};
}

function validateOwner(owner: OwnerRegistration): void {
	if (!owner.id.trim() || Buffer.byteLength(owner.id, "utf8") > 256) {
		throw new Error("owner ID must contain 1-256 UTF-8 bytes");
	}
}

function toolResources(
	agent: DiscoveredAgent,
	request: SubagentRequest,
	implementation: { canonicalPath: string; sha256: string },
) {
	const resources: ResourceGrant[] = [
		{
			kind: "agent",
			name: agent.name,
			source: agent.source,
			sha256: agent.sha256,
		},
	];
	for (const tool of request.tools) {
		if (!IMPLEMENTED_TOOLS.has(tool)) {
			throw new Error(`tool implementation unavailable: ${tool}`);
		}
		resources.push({
			kind: "tool",
			name: tool,
			source: `${implementation.canonicalPath}#${tool}`,
			sha256: canonicalSha256({
				implementationSha256: implementation.sha256,
				tool,
			}),
		});
	}
	return resources;
}

export async function createSubagentService(options: {
	root: string;
	agents: Map<string, DiscoveredAgent>;
	modelRuntime: ModelRuntime;
	capacity: VmCapacityManager;
	sandbox: ResolvedSandbox;
	preflightTtlMs?: number;
	resolveModel?: (model: ExactModelRequest) => Promise<ExactModelRequest>;
	executeAttempt?: AttemptExecutor;
}): Promise<SubagentService> {
	await mkdir(options.root, { recursive: true, mode: 0o700 });
	const toolImplementation = await digestFileResource(
		fileURLToPath(new URL("./sandbox/tools.ts", import.meta.url)),
	);
	const operationIndex = await OperationIndex.open(
		path.join(options.root, "operations"),
	);
	const preflights = new Map<string, PreparedPreflight>();
	const runs = new Map<string, ActiveRun>();
	let launchTail = Promise.resolve();
	const runExclusive = async <T>(operation: () => Promise<T>): Promise<T> => {
		const previous = launchTail;
		let release = () => {};
		launchTail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await operation();
		} finally {
			release();
		}
	};
	const preflightTtlMs = options.preflightTtlMs ?? 5 * 60_000;
	const executeAttempt = options.executeAttempt ?? runNativeAttempt;
	const resolveModel =
		options.resolveModel ?? createExactModelResolver(options.modelRuntime);

	return {
		forOwner(owner) {
			validateOwner(owner);

			const ownedRun = (runId: RunId): ActiveRun => {
				const run = runs.get(runId);
				if (!run || run.ownerId !== owner.id) throw new Error("run not found");
				return run;
			};

			return {
				async preflight(request) {
					for (const [id, prepared] of preflights) {
						if (Date.parse(prepared.expiresAt) <= Date.now())
							preflights.delete(id);
					}
					if (preflights.size >= 256) {
						throw new Error("preflight capacity exhausted");
					}
					if (request.skills.length > 0) {
						throw new Error("explicit skills are not implemented");
					}
					if (request.outputSchema !== undefined) {
						createFinalAnswerController(request.outputSchema);
					}
					const agent = options.agents.get(request.agent);
					if (!agent) throw new Error(`agent not found: ${request.agent}`);
					const workspace = await preflightWorkspace(request.workspace);
					const ids = deterministicIds(owner.id, request);
					const launchPlan = await compileLaunchPlan({
						ownerId: owner.id,
						runId: ids.runId,
						attemptId: ids.attemptId,
						request,
						agent,
						resources: toolResources(agent, request, toolImplementation),
						workspace,
						sandbox: options.sandbox,
						resolveModel,
					});
					const preflightId = randomUUID();
					const prepared: PreparedPreflight = {
						preflightId,
						identitySha256: launchPlan.identitySha256,
						expiresAt: new Date(Date.now() + preflightTtlMs).toISOString(),
						launchPlan,
						ownerId: owner.id,
						requestSha256: ids.requestSha256,
						agent,
						workspace,
					};
					preflights.set(preflightId, prepared);
					return {
						preflightId,
						identitySha256: prepared.identitySha256,
						expiresAt: prepared.expiresAt,
						launchPlan,
					};
				},

				async launch(preflightId, expectedIdentitySha256) {
					const prepared = preflights.get(preflightId);
					if (!prepared || prepared.ownerId !== owner.id) {
						throw new Error("preflight not found");
					}
					if (Date.parse(prepared.expiresAt) <= Date.now()) {
						preflights.delete(preflightId);
						throw new Error("preflight expired");
					}
					if (prepared.identitySha256 !== expectedIdentitySha256) {
						throw new Error("preflight identity mismatch");
					}
					const currentAgent = options.agents.get(prepared.agent.name);
					if (
						!currentAgent ||
						currentAgent.source !== prepared.agent.source ||
						currentAgent.sha256 !== prepared.agent.sha256
					) {
						throw new Error("agent changed after preflight");
					}
					if (path.isAbsolute(currentAgent.source)) {
						const digest = await digestFileResource(currentAgent.source);
						if (digest.sha256 !== currentAgent.sha256) {
							throw new Error("agent changed after preflight");
						}
					}
					await resolveModel(prepared.launchPlan.model);
					const currentWorkspace = await preflightWorkspace({
						mode: prepared.workspace.mode,
						cwd: prepared.workspace.cwd,
					});
					if (
						currentWorkspace.hostPathSha256 !==
							prepared.workspace.hostPathSha256 ||
						currentWorkspace.baselineSha256 !==
							prepared.workspace.baselineSha256
					) {
						throw new Error("workspace changed after preflight");
					}
					return runExclusive(async () => {
						const existing = runs.get(prepared.launchPlan.runId);
						if (existing) {
							if (existing.ownerId !== owner.id)
								throw new Error("run ownership mismatch");
							return {
								runId: existing.plan.runId,
								attemptId: existing.plan.attemptId,
								status: existing.status,
							};
						}
						await operationIndex.claim({
							ownerId: owner.id,
							operationId: prepared.launchPlan.operationId,
							requestSha256: prepared.requestSha256,
							runId: prepared.launchPlan.runId,
						});
						const lease = await acquireRunLease({
							root: path.join(options.root, "leases"),
							runId: prepared.launchPlan.runId,
						});
						try {
							const journal = await RunJournal.open(
								path.join(options.root, "runs"),
								prepared.launchPlan.runId,
								lease,
							);
							const artifacts = await ArtifactStore.open({
								root: path.join(
									options.root,
									"runs",
									prepared.launchPlan.runId,
									"artifacts",
								),
								maxArtifactBytes: prepared.launchPlan.limits.outputBytes,
								maxTotalBytes: prepared.launchPlan.limits.outputBytes,
								lease,
							});
							let worktree: WorktreeRecord | undefined;
							let workspacePath = prepared.workspace.cwd;
							if (prepared.launchPlan.workspace.mode === "worktree") {
								worktree = await createAttemptWorktree({
									root: path.join(options.root, "workspace"),
									runId: prepared.launchPlan.runId,
									attemptId: prepared.launchPlan.attemptId,
									workspace: prepared.workspace,
									lease,
								});
								workspacePath =
									prepared.workspace.relativeCwd === "."
										? worktree.worktreePath
										: path.join(
												worktree.worktreePath,
												prepared.workspace.relativeCwd,
											);
							}
							const abort = new AbortController();
							const rawPromise = executeAttempt({
								plan: prepared.launchPlan,
								agent: prepared.agent,
								workspacePath,
								...(worktree ? { worktree } : {}),
								modelRuntime: options.modelRuntime,
								capacity: options.capacity,
								lease,
								journal,
								artifactStore: artifacts,
								sessionRoot: path.join(options.root, "sessions"),
								signal: abort.signal,
							});
							const active: ActiveRun = {
								ownerId: owner.id,
								plan: prepared.launchPlan,
								journal,
								artifacts,
								lease,
								abort,
								promise: rawPromise,
								status: "active",
							};
							active.promise = rawPromise.then(
								async (result) => {
									active.result = result;
									active.status = result.result.status;
									if (result.result.status !== "cleanup-blocked") {
										try {
											await lease.release();
										} catch (error) {
											active.status = "cleanup-blocked";
											throw error;
										}
									}
									return result;
								},
								(error: unknown) => {
									active.status = "cleanup-blocked";
									throw error;
								},
							);
							runs.set(prepared.launchPlan.runId, active);
							return {
								runId: prepared.launchPlan.runId,
								attemptId: prepared.launchPlan.attemptId,
								status: "active",
							};
						} catch (error) {
							await lease.release();
							throw error;
						}
					});
				},

				async status(runId) {
					const run = ownedRun(runId);
					return {
						runId,
						attemptId: run.plan.attemptId,
						status: run.status,
						...(run.result ? { result: run.result } : {}),
					};
				},

				async logs(runId) {
					return ownedRun(runId).journal.readEvents();
				},

				async wait(runId) {
					return ownedRun(runId).promise;
				},

				async exportArtifact(runId, ref, maxBytes) {
					const run = ownedRun(runId);
					return run.artifacts.export(
						ref,
						maxBytes ?? run.plan.limits.outputBytes,
					);
				},

				async interrupt(runId) {
					const run = ownedRun(runId);
					if (run.status === "active") {
						run.status = "stopping";
						run.abort.abort();
					}
					return {
						runId,
						attemptId: run.plan.attemptId,
						status: run.status,
					};
				},
			};
		},
	};
}
