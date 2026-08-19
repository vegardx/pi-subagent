import { randomUUID } from "node:crypto";
import { mkdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	getAgentDir,
	type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { type ArtifactExport, ArtifactStore } from "./artifacts/store.js";
import {
	type ArtifactRef,
	type AttemptId,
	isRunResult,
	type RunId,
	type RunResult,
	type RunStatus,
	type Usage,
} from "./contracts.js";
import type {
	AgentLaunchPlan,
	ExactModelRequest,
	ResourceGrant,
	SubagentRequest,
} from "./launch-contracts.js";
import { AttemptRecordStore } from "./persistence/attempt-record.js";
import { type JournalEvent, RunJournal } from "./persistence/journal.js";
import { OperationIndex } from "./persistence/operation-index.js";
import {
	acquireRunLease,
	type RunLease,
	RunLeaseUnavailableError,
} from "./persistence/run-lease.js";
import { RunRecordStore } from "./persistence/run-record.js";
import type { DiscoveredAgent } from "./preflight/agents.js";
import { canonicalSha256 } from "./preflight/canonical.js";
import {
	compileLaunchPlan,
	type ResolvedSandbox,
} from "./preflight/compile.js";
import { createExactModelResolver } from "./preflight/models.js";
import { digestFileResource } from "./preflight/resources.js";
import {
	discoverAndProjectSkills,
	type SkillProjection,
} from "./preflight/skills.js";
import {
	preflightWorkspace,
	type WorkspacePreflight,
} from "./preflight/workspace.js";
import {
	type AttemptControl,
	type AttemptExecutionResult,
	runNativeAttempt,
} from "./runtime/attempt.js";
import { createFinalAnswerController } from "./runtime/structured-output.js";
import type { VmCapacityManager } from "./sandbox/capacity.js";
import {
	createAttemptWorktree,
	readWorktreeRecord,
	releaseWorktreeBranch,
	removeCleanWorktree,
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

export type ControlInput = {
	operationId: string;
	text: string;
};

export type ControlReceipt = {
	operationId: string;
	state: "accepted-by-session" | "missed" | "failed";
};

export type ReconcileResult = {
	run: RunView;
	sandboxProcess: "absent" | "present" | "not-started" | "unknown";
	workspace: "not-needed" | "retained" | "absent" | "unknown";
};

export type SubagentClient = {
	preflight(request: SubagentRequest): Promise<SubagentPreflight>;
	launch(
		preflightId: string,
		expectedIdentitySha256: string,
	): Promise<RunReceipt>;
	findByOperation(operationId: string): Promise<RunReceipt | undefined>;
	status(runId: RunId): Promise<RunView>;
	logs(runId: RunId): Promise<JournalEvent[]>;
	wait(runId: RunId): Promise<AttemptExecutionResult>;
	interrupt(runId: RunId): Promise<RunReceipt>;
	steer(runId: RunId, input: ControlInput): Promise<ControlReceipt>;
	followUp(runId: RunId, input: ControlInput): Promise<ControlReceipt>;
	retry(runId: RunId): Promise<RunReceipt>;
	resume(runId: RunId): Promise<RunReceipt>;
	reconcile(runId: RunId): Promise<ReconcileResult>;
	release(runId: RunId): Promise<RunReceipt>;
	exportArtifact(
		runId: RunId,
		ref: ArtifactRef,
		maxBytes?: number,
	): Promise<ArtifactExport>;
};

export type SubagentService = {
	forOwner(owner: OwnerRegistration): SubagentClient;
	shutdown(): Promise<void>;
};

type PreparedPreflight = SubagentPreflight & {
	ownerId: string;
	requestSha256: string;
	agent: DiscoveredAgent;
	workspace: WorkspacePreflight;
	skills: SkillProjection;
};

type ActiveRun = {
	ownerId: string;
	plan: AgentLaunchPlan;
	workspace: WorkspacePreflight;
	skills: SkillProjection;
	journal: RunJournal;
	artifacts: ArtifactStore;
	abort: AbortController;
	promise: Promise<AttemptExecutionResult>;
	result?: AttemptExecutionResult;
	status: RunStatus;
	control?: AttemptControl;
	controlReceipts: Map<string, ControlReceipt>;
	controlTail: Promise<void>;
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

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: 0,
	};
}

function processState(pid: number): "absent" | "present" | "unknown" {
	try {
		process.kill(pid, 0);
		return "present";
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return "absent";
		return "unknown";
	}
}

async function pathState(
	filePath: string,
): Promise<"present" | "absent" | "unknown"> {
	try {
		await stat(filePath);
		return "present";
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
		return "unknown";
	}
}

function retryPlan(
	current: AgentLaunchPlan,
	result: AttemptExecutionResult,
	ordinal: number,
): AgentLaunchPlan {
	if (current.limits.retries < 1) throw new Error("retry budget exhausted");
	const remainingTokens =
		current.limits.tokens - result.result.usage.totalTokens;
	const remainingCost = current.limits.cost - result.result.usage.cost;
	if (remainingTokens < 1 || remainingCost <= 0) {
		throw new Error("retry run-wide usage budget exhausted");
	}
	const attemptId = `attempt_${canonicalSha256({
		runId: current.runId,
		parentAttemptId: current.attemptId,
		ordinal,
		kind: "retry",
	}).slice(0, 48)}`;
	const { identitySha256: _identity, ...base } = current;
	const draft = {
		...base,
		attemptId,
		limits: {
			...current.limits,
			tokens: remainingTokens,
			cost: remainingCost,
			retries: current.limits.retries - 1,
		},
	};
	return { ...draft, identitySha256: canonicalSha256(draft) };
}

function resumePlan(
	current: AgentLaunchPlan,
	result: AttemptExecutionResult,
	ordinal: number,
): AgentLaunchPlan {
	if (current.limits.resumes < 1) throw new Error("resume budget exhausted");
	const remainingTokens =
		current.limits.tokens - result.result.usage.totalTokens;
	const remainingCost = current.limits.cost - result.result.usage.cost;
	if (remainingTokens < 1 || remainingCost <= 0) {
		throw new Error("resume run-wide usage budget exhausted");
	}
	const attemptId = `attempt_${canonicalSha256({
		runId: current.runId,
		parentAttemptId: current.attemptId,
		ordinal,
		kind: "resume",
	}).slice(0, 48)}`;
	const { identitySha256: _identity, ...base } = current;
	const draft = {
		...base,
		attemptId,
		limits: {
			...current.limits,
			tokens: remainingTokens,
			cost: remainingCost,
			resumes: current.limits.resumes - 1,
		},
	};
	return { ...draft, identitySha256: canonicalSha256(draft) };
}

function isInsidePath(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return (
		relative === "" ||
		(relative !== ".." &&
			!relative.startsWith(`..${path.sep}`) &&
			!path.isAbsolute(relative))
	);
}

function assertSkillProjection(
	plan: AgentLaunchPlan,
	skills: SkillProjection,
): void {
	const planned = plan.resources
		.filter((resource) => resource.kind === "skill")
		.map((resource) => `${resource.name}:${resource.source}:${resource.sha256}`)
		.sort();
	const current = skills.catalog
		.map((skill) => `${skill.name}:${skill.hostFilePath}:${skill.sha256}`)
		.sort();
	if (canonicalSha256(planned) !== canonicalSha256(current)) {
		throw new Error("skill catalog changed after preflight");
	}
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
	skills: SkillProjection,
) {
	const resources: ResourceGrant[] = [
		{
			kind: "agent",
			name: agent.name,
			source: agent.source,
			sha256: agent.sha256,
		},
	];
	for (const skill of skills.catalog) {
		resources.push({
			kind: "skill",
			name: skill.name,
			source: skill.hostFilePath,
			sha256: skill.sha256,
		});
	}
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
	agentDir?: string;
	isProjectTrusted?: (cwd: string) => boolean;
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
	const runRecords = await RunRecordStore.open(
		path.join(options.root, "run-records"),
	);
	const attemptRecords = await AttemptRecordStore.open(
		path.join(options.root, "attempt-records"),
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
	const agentDir = options.agentDir ?? getAgentDir();
	const executeAttempt = options.executeAttempt ?? runNativeAttempt;
	const resolveModel =
		options.resolveModel ?? createExactModelResolver(options.modelRuntime);

	for (const record of await runRecords.list()) {
		const recoveredSkills: SkillProjection = {
			catalog: [],
			preloadPrompt: "",
		};
		const latestAttempt = await attemptRecords.latest(record.plan.runId);
		const recoveredPlan = latestAttempt?.plan ?? record.plan;
		let lease: RunLease;
		try {
			lease = await acquireRunLease({
				root: path.join(options.root, "leases"),
				runId: recoveredPlan.runId,
			});
		} catch (error) {
			if (error instanceof RunLeaseUnavailableError) continue;
			throw error;
		}
		try {
			const journal = await RunJournal.open(
				path.join(options.root, "runs"),
				recoveredPlan.runId,
				lease,
			);
			const artifacts = await ArtifactStore.open({
				root: path.join(options.root, "runs", recoveredPlan.runId, "artifacts"),
				maxArtifactBytes: recoveredPlan.limits.outputBytes,
				maxTotalBytes: recoveredPlan.limits.outputBytes,
				lease,
			});
			const snapshot = await journal.readSnapshot();
			const state = snapshot?.state as
				| {
						result?: unknown;
						output?: unknown;
						sessionFile?: unknown;
						handoff?: unknown;
						error?: unknown;
				  }
				| undefined;
			const persistedResult = state?.result;
			let result: RunResult;
			if (isRunResult(persistedResult)) {
				result = persistedResult;
			} else {
				result = {
					runId: recoveredPlan.runId,
					status: "cleanup-blocked",
					usage: emptyUsage(),
					usageComplete: false,
					sandboxCleanup: "unknown",
					workspaceCleanup:
						recoveredPlan.workspace.mode === "read-only"
							? "not-needed"
							: "unknown",
					truncated: false,
				};
				await journal.append("startup-reconciled", {
					status: "cleanup-blocked",
					reason: "terminal state was not proved before seat loss",
				});
				await journal.writeSnapshot({
					result,
					error: "terminal state was not proved before seat loss",
				});
			}
			const execution: AttemptExecutionResult = {
				result,
				output: typeof state?.output === "string" ? state.output : "",
				sessionFile:
					typeof state?.sessionFile === "string"
						? state.sessionFile
						: undefined,
				handoff: undefined,
				structuredOutput: result.structuredOutput,
				error: typeof state?.error === "string" ? state.error : undefined,
			};
			const abort = new AbortController();
			const active: ActiveRun = {
				ownerId: record.ownerId,
				plan: recoveredPlan,
				workspace: record.workspace,
				skills: recoveredSkills,
				journal,
				artifacts,
				abort,
				promise: Promise.resolve(execution),
				result: execution,
				status: result.status,
				controlReceipts: new Map(),
				controlTail: Promise.resolve(),
			};
			runs.set(recoveredPlan.runId, active);
		} finally {
			await lease.release();
		}
	}

	const startAttempt = async (input: {
		ownerId: string;
		plan: AgentLaunchPlan;
		agent: DiscoveredAgent;
		workspace: WorkspacePreflight;
		skills: SkillProjection;
		kind: "initial" | "retry" | "resume";
		ordinal: number;
		parentAttemptId?: AttemptId;
		rootPlan: AgentLaunchPlan;
		resumeSessionFile?: string;
		existingWorktree?: WorktreeRecord;
	}): Promise<RunReceipt> => {
		const lease = await acquireRunLease({
			root: path.join(options.root, "leases"),
			runId: input.plan.runId,
		});
		try {
			const journal = await RunJournal.open(
				path.join(options.root, "runs"),
				input.plan.runId,
				lease,
			);
			const artifacts = await ArtifactStore.open({
				root: path.join(options.root, "runs", input.plan.runId, "artifacts"),
				maxArtifactBytes: input.rootPlan.limits.outputBytes,
				maxTotalBytes:
					input.rootPlan.limits.outputBytes *
					(input.rootPlan.limits.retries + input.rootPlan.limits.resumes + 1),
				lease,
			});
			if (input.kind === "initial") {
				await runRecords.create(input.ownerId, input.rootPlan, input.workspace);
			}
			let worktree = input.existingWorktree;
			let workspacePath = input.workspace.cwd;
			if (input.plan.workspace.mode === "worktree" && !worktree) {
				worktree = await createAttemptWorktree({
					root: path.join(options.root, "workspace"),
					runId: input.plan.runId,
					attemptId: input.plan.attemptId,
					workspace: input.workspace,
					lease,
				});
			}
			if (worktree) {
				workspacePath =
					input.workspace.relativeCwd === "."
						? worktree.worktreePath
						: path.join(worktree.worktreePath, input.workspace.relativeCwd);
			}
			await attemptRecords.create({
				ownerId: input.ownerId,
				plan: input.plan,
				ordinal: input.ordinal,
				kind: input.kind,
				...(input.parentAttemptId
					? { parentAttemptId: input.parentAttemptId }
					: {}),
				...(worktree ? { worktreeAttemptId: worktree.attemptId } : {}),
			});
			const abort = new AbortController();
			let active: ActiveRun | undefined;
			let pendingControl: AttemptControl | undefined;
			const rawPromise = executeAttempt({
				plan: input.plan,
				agent: input.agent,
				workspacePath,
				workspaceAliases: [input.workspace.cwd],
				...(worktree ? { worktree } : {}),
				modelRuntime: options.modelRuntime,
				capacity: options.capacity,
				lease,
				journal,
				artifactStore: artifacts,
				skills: input.skills,
				sessionRoot: path.join(options.root, "sessions"),
				...(input.resumeSessionFile
					? { resumeSessionFile: input.resumeSessionFile }
					: {}),
				registerControl(control) {
					pendingControl = control;
					if (active && control) active.control = control;
					else if (active) delete active.control;
				},
				signal: abort.signal,
			});
			active = {
				ownerId: input.ownerId,
				plan: input.plan,
				workspace: input.workspace,
				skills: input.skills,
				journal,
				artifacts,
				abort,
				promise: rawPromise,
				status: "active",
				controlReceipts: new Map(),
				controlTail: Promise.resolve(),
				...(pendingControl ? { control: pendingControl } : {}),
			};
			const running = active;
			running.promise = rawPromise.then(
				async (result) => {
					running.result = result;
					running.status = result.result.status;
					if (result.result.status !== "cleanup-blocked") {
						try {
							await lease.release();
						} catch (error) {
							running.status = "cleanup-blocked";
							throw error;
						}
					}
					return result;
				},
				(error: unknown) => {
					running.status = "cleanup-blocked";
					throw error;
				},
			);
			runs.set(input.plan.runId, running);
			return {
				runId: input.plan.runId,
				attemptId: input.plan.attemptId,
				status: "active",
			};
		} catch (error) {
			await lease.release();
			throw error;
		}
	};

	return {
		async shutdown() {
			const pending: Promise<unknown>[] = [];
			for (const run of runs.values()) {
				if (run.status !== "active" && run.status !== "stopping") continue;
				run.status = "stopping";
				run.abort.abort();
				pending.push(run.promise);
			}
			await Promise.allSettled(pending);
		},

		forOwner(owner) {
			validateOwner(owner);

			const ownedRun = (runId: RunId): ActiveRun => {
				const run = runs.get(runId);
				if (!run || run.ownerId !== owner.id) throw new Error("run not found");
				return run;
			};

			const deliverControl = async (
				runId: RunId,
				kind: "steer" | "follow-up",
				input: ControlInput,
			): Promise<ControlReceipt> => {
				if (
					!input.operationId.trim() ||
					Buffer.byteLength(input.operationId, "utf8") > 256 ||
					!input.text.trim() ||
					Buffer.byteLength(input.text, "utf8") > 64 * 1024
				) {
					throw new Error("invalid control input");
				}
				const run = ownedRun(runId);
				const requestSha256 = canonicalSha256({ kind, text: input.text });
				await operationIndex.claim({
					ownerId: owner.id,
					operationId: input.operationId,
					requestSha256,
					runId,
				});
				const operation = run.controlTail.then(async () => {
					const existing = run.controlReceipts.get(input.operationId);
					if (existing) return existing;
					let receipt: ControlReceipt;
					if (run.status !== "active" || !run.control) {
						receipt = { operationId: input.operationId, state: "missed" };
					} else {
						try {
							if (kind === "steer") await run.control.steer(input.text);
							else await run.control.followUp(input.text);
							receipt = {
								operationId: input.operationId,
								state: "accepted-by-session",
							};
							await run.journal.append("control-accepted", {
								kind,
								...receipt,
							});
						} catch {
							receipt = { operationId: input.operationId, state: "failed" };
							await run.journal.append("control-failed", {
								kind,
								...receipt,
							});
						}
					}
					run.controlReceipts.set(input.operationId, receipt);
					return receipt;
				});
				run.controlTail = operation.then(
					() => undefined,
					() => undefined,
				);
				return operation;
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
					if (request.outputSchema !== undefined) {
						createFinalAnswerController(request.outputSchema);
					}
					const agent = options.agents.get(request.agent);
					if (!agent) throw new Error(`agent not found: ${request.agent}`);
					const workspace = await preflightWorkspace(request.workspace);
					const skills = await discoverAndProjectSkills({
						cwd: workspace.cwd,
						agentDir,
						projectTrusted: options.isProjectTrusted?.(workspace.cwd) ?? false,
						preloadSkills: [
							...new Set([...agent.preloadSkills, ...request.preloadSkills]),
						],
					});
					const ids = deterministicIds(owner.id, request);
					const launchPlan = await compileLaunchPlan({
						ownerId: owner.id,
						runId: ids.runId,
						attemptId: ids.attemptId,
						request,
						agent,
						resources: toolResources(
							agent,
							request,
							toolImplementation,
							skills,
						),
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
						skills,
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
					const currentSkills = await discoverAndProjectSkills({
						cwd: currentWorkspace.cwd,
						agentDir,
						projectTrusted:
							options.isProjectTrusted?.(currentWorkspace.cwd) ?? false,
						preloadSkills: prepared.launchPlan.preloadSkills,
					});
					assertSkillProjection(prepared.launchPlan, currentSkills);
					prepared.skills = currentSkills;
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
						return startAttempt({
							ownerId: owner.id,
							plan: prepared.launchPlan,
							agent: prepared.agent,
							workspace: prepared.workspace,
							skills: prepared.skills,
							kind: "initial",
							ordinal: 0,
							rootPlan: prepared.launchPlan,
						});
					});
				},

				async findByOperation(operationId) {
					const record = await operationIndex.find(owner.id, operationId);
					if (!record) return undefined;
					const run = runs.get(record.runId);
					return {
						runId: record.runId,
						attemptId:
							run?.plan.attemptId ?? `attempt_${record.runId.slice(4)}`,
						status: run?.status ?? "active",
					};
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

				async steer(runId, input) {
					return deliverControl(runId, "steer", input);
				},

				async followUp(runId, input) {
					return deliverControl(runId, "follow-up", input);
				},

				async retry(runId) {
					return runExclusive(async () => {
						const run = ownedRun(runId);
						if (run.status !== "failed" || !run.result) {
							throw new Error("run is not retryable");
						}
						const latest = await attemptRecords.latest(runId);
						if (!latest || latest.attemptId !== run.plan.attemptId) {
							throw new Error("attempt history mismatch");
						}
						const rootRecord = await runRecords.read(runId);
						const workspace = await preflightWorkspace({
							mode: run.workspace.mode,
							cwd: run.workspace.cwd,
						});
						if (
							workspace.hostPathSha256 !== run.workspace.hostPathSha256 ||
							workspace.baselineSha256 !== run.workspace.baselineSha256
						) {
							throw new Error("workspace changed before retry");
						}
						const agent = options.agents.get(run.plan.agent);
						if (!agent) throw new Error("agent unavailable for retry");
						if (path.isAbsolute(agent.source)) {
							const digest = await digestFileResource(agent.source);
							if (digest.sha256 !== agent.sha256) {
								throw new Error("agent changed before retry");
							}
						}
						await resolveModel(run.plan.model);
						const skills = await discoverAndProjectSkills({
							cwd: workspace.cwd,
							agentDir,
							projectTrusted:
								options.isProjectTrusted?.(workspace.cwd) ?? false,
							preloadSkills: run.plan.preloadSkills,
						});
						assertSkillProjection(run.plan, skills);
						const plan = retryPlan(run.plan, run.result, latest.ordinal + 1);
						return startAttempt({
							ownerId: owner.id,
							plan,
							agent,
							workspace,
							skills,
							kind: "retry",
							ordinal: latest.ordinal + 1,
							parentAttemptId: latest.attemptId,
							rootPlan: rootRecord.plan,
						});
					});
				},

				async resume(runId) {
					return runExclusive(async () => {
						const run = ownedRun(runId);
						if (run.status !== "interrupted" || !run.result?.sessionFile) {
							throw new Error("run is not resumable");
						}
						const latest = await attemptRecords.latest(runId);
						if (!latest || latest.attemptId !== run.plan.attemptId) {
							throw new Error("attempt history mismatch");
						}
						const rootRecord = await runRecords.read(runId);
						const sessionsRoot = await realpath(
							path.join(options.root, "sessions"),
						);
						const sessionFile = await realpath(run.result.sessionFile);
						if (!isInsidePath(sessionsRoot, sessionFile)) {
							throw new Error("retained session escapes session root");
						}
						const workspace = await preflightWorkspace({
							mode: run.workspace.mode,
							cwd: run.workspace.cwd,
						});
						if (
							workspace.hostPathSha256 !== run.workspace.hostPathSha256 ||
							workspace.baselineSha256 !== run.workspace.baselineSha256
						) {
							throw new Error("workspace changed before resume");
						}
						const agent = options.agents.get(run.plan.agent);
						if (!agent) throw new Error("agent unavailable for resume");
						if (path.isAbsolute(agent.source)) {
							const digest = await digestFileResource(agent.source);
							if (digest.sha256 !== agent.sha256) {
								throw new Error("agent changed before resume");
							}
						}
						await resolveModel(run.plan.model);
						const skills = await discoverAndProjectSkills({
							cwd: workspace.cwd,
							agentDir,
							projectTrusted:
								options.isProjectTrusted?.(workspace.cwd) ?? false,
							preloadSkills: run.plan.preloadSkills,
						});
						assertSkillProjection(run.plan, skills);
						const plan = resumePlan(run.plan, run.result, latest.ordinal + 1);
						let existingWorktree: WorktreeRecord | undefined;
						if (run.plan.workspace.mode === "worktree") {
							existingWorktree = await readWorktreeRecord(
								path.join(
									options.root,
									"workspace",
									"records",
									`${latest.worktreeAttemptId ?? latest.attemptId}.json`,
								),
							);
						}
						return startAttempt({
							ownerId: owner.id,
							plan,
							agent,
							workspace,
							skills,
							kind: "resume",
							ordinal: latest.ordinal + 1,
							parentAttemptId: latest.attemptId,
							rootPlan: rootRecord.plan,
							resumeSessionFile: sessionFile,
							...(existingWorktree ? { existingWorktree } : {}),
						});
					});
				},

				async reconcile(runId) {
					const run = ownedRun(runId);
					if (run.status !== "cleanup-blocked") {
						return {
							run: {
								runId,
								attemptId: run.plan.attemptId,
								status: run.status,
								...(run.result ? { result: run.result } : {}),
							},
							sandboxProcess: "absent",
							workspace:
								run.plan.workspace.mode === "read-only"
									? "not-needed"
									: "absent",
						};
					}
					const lease = await acquireRunLease({
						root: path.join(options.root, "leases"),
						runId,
					});
					try {
						const journal = await RunJournal.open(
							path.join(options.root, "runs"),
							runId,
							lease,
						);
						const events = await journal.readEvents();
						const sandboxEvent = [...events]
							.reverse()
							.find((event) => event.type === "sandbox-started");
						const hostPid = (
							sandboxEvent?.data as { hostPid?: unknown } | undefined
						)?.hostPid;
						const sandboxProcess =
							sandboxEvent === undefined
								? "not-started"
								: typeof hostPid === "number"
									? processState(hostPid)
									: "unknown";
						const latestAttempt = await attemptRecords.latest(runId);
						const worktreePath = path.join(
							options.root,
							"workspace",
							"worktrees",
							latestAttempt?.worktreeAttemptId ?? run.plan.attemptId,
						);
						const observedWorktree =
							run.plan.workspace.mode === "read-only"
								? "absent"
								: await pathState(worktreePath);
						const workspace =
							run.plan.workspace.mode === "read-only"
								? "not-needed"
								: observedWorktree === "present"
									? "retained"
									: observedWorktree === "absent"
										? "absent"
										: "unknown";
						const sandboxCleanup =
							sandboxProcess === "not-started"
								? "not-needed"
								: sandboxProcess === "absent"
									? "proved"
									: "unknown";
						const workspaceCleanup =
							workspace === "not-needed"
								? "not-needed"
								: workspace === "retained"
									? "retained"
									: workspace === "absent"
										? "proved"
										: "unknown";
						const sessionFile = run.result?.sessionFile;
						const canClassify =
							(sandboxCleanup === "proved" ||
								sandboxCleanup === "not-needed") &&
							workspaceCleanup !== "unknown";
						const status: RunResult["status"] = canClassify
							? sessionFile
								? "interrupted"
								: "failed"
							: "cleanup-blocked";
						const result: RunResult = {
							runId,
							status,
							...(run.result?.result.output
								? { output: run.result.result.output }
								: {}),
							...(run.result?.result.structuredOutput !== undefined
								? { structuredOutput: run.result.result.structuredOutput }
								: {}),
							usage: run.result?.result.usage ?? emptyUsage(),
							usageComplete: run.result?.result.usageComplete ?? false,
							sandboxCleanup,
							workspaceCleanup,
							truncated: run.result?.result.truncated ?? false,
						};
						if (!isRunResult(result)) {
							throw new Error("reconciliation produced invalid result");
						}
						const execution: AttemptExecutionResult = {
							result,
							output: run.result?.output ?? "",
							sessionFile,
							handoff: run.result?.handoff,
							structuredOutput: result.structuredOutput,
							error:
								status === "cleanup-blocked"
									? "external cleanup remains unproved"
									: "prior attempt was interrupted before terminal proof",
						};
						await journal.append("run-reconciled", {
							status,
							sandboxProcess,
							workspace,
						});
						await journal.writeSnapshot(execution);
						run.journal = journal;
						run.result = execution;
						run.promise = Promise.resolve(execution);
						run.status = status;
						return {
							run: {
								runId,
								attemptId: run.plan.attemptId,
								status,
								result: execution,
							},
							sandboxProcess,
							workspace,
						};
					} finally {
						await lease.release();
					}
				},

				async release(runId) {
					return runExclusive(async () => {
						const run = ownedRun(runId);
						if (run.status === "active" || run.status === "stopping") {
							throw new Error("active run cannot be released");
						}
						const lease = await acquireRunLease({
							root: path.join(options.root, "leases"),
							runId,
						});
						try {
							const journal = await RunJournal.open(
								path.join(options.root, "runs"),
								runId,
								lease,
							);
							if (run.plan.workspace.mode === "worktree") {
								const attempts = await attemptRecords.list(runId);
								const worktreeAttempts = [
									...new Set(
										attempts
											.map((attempt) => attempt.worktreeAttemptId)
											.filter(
												(attemptId): attemptId is string =>
													attemptId !== undefined,
											),
									),
								];
								if (worktreeAttempts.length === 0) {
									throw new Error("worktree identity is unavailable");
								}
								for (const worktreeAttemptId of worktreeAttempts) {
									const record = await readWorktreeRecord(
										path.join(
											options.root,
											"workspace",
											"records",
											`${worktreeAttemptId}.json`,
										),
									);
									if ((await pathState(record.worktreePath)) === "present") {
										await removeCleanWorktree(record, lease);
									}
									await releaseWorktreeBranch(record, lease);
								}
							}
							if (run.result) {
								const result: RunResult = {
									...run.result.result,
									workspaceCleanup:
										run.plan.workspace.mode === "read-only"
											? "not-needed"
											: "proved",
								};
								if (
									result.status === "cleanup-blocked" &&
									result.sandboxCleanup === "proved"
								) {
									result.status = "failed";
								}
								if (!isRunResult(result))
									throw new Error("release produced invalid result");
								run.result = { ...run.result, result };
								run.status = result.status;
								run.promise = Promise.resolve(run.result);
							}
							await journal.append("run-released", {
								workspace: run.plan.workspace.mode,
							});
							if (run.result) await journal.writeSnapshot(run.result);
							run.journal = journal;
							return {
								runId,
								attemptId: run.plan.attemptId,
								status: run.status,
							};
						} finally {
							await lease.release();
						}
					});
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
