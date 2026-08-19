import { randomUUID } from "node:crypto";
import { access, mkdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	getAgentDir,
	type ModelRuntime,
	SessionManager,
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
	createRetentionManager,
	type RetentionPin,
	type RetentionReport,
	type RetentionRun,
} from "./persistence/retention.js";
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
import {
	type ForkContextProjection,
	projectForkContext,
} from "./preflight/context.js";
import {
	assertContextFileProjection,
	type ContextFileProjection,
	discoverAndProjectContextFiles,
} from "./preflight/context-files.js";
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
	createHostProcessController,
	type ProcessController,
	type ProcessIdentity,
	processIdentitiesEqual,
} from "./reconciliation/process.js";
import {
	type AttemptControl,
	type AttemptExecutionResult,
	runNativeAttempt,
} from "./runtime/attempt.js";
import { createFinalAnswerController } from "./runtime/structured-output.js";
import type { VmCapacityManager } from "./sandbox/capacity.js";
import {
	createAttemptWorktree,
	observeWorktree,
	readWorktreeRecord,
	releaseWorktreeBranch,
	removeCleanWorktree,
	type WorktreeRecord,
} from "./workspace/worktree.js";

export type OwnerRegistration = {
	id: string;
	parentSessionId?: string;
	parentSessionFile?: string;
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

export type RunSummary = {
	runId: RunId;
	attemptId: AttemptId;
	ownerId: string;
	agentName: string;
	agentDisplayName: string;
	goalPreview: string;
	status: RunStatus;
	repositoryRoot: string;
	workspaceMode: "read-only" | "worktree";
	createdAt: string;
	updatedAt: string;
	usage?: RunResult["usage"];
	pinned: boolean;
	controllable: boolean;
	retryable: boolean;
	retryAt?: string;
	resumable: boolean;
	retainedWorktree: boolean;
	requiresAttention: boolean;
};

export type RunQuery = {
	repositoryRoot?: string;
	ownerId?: string;
	statuses?: RunStatus[];
	search?: string;
	limit?: number;
	cursor?: string;
};

export type RunPage = {
	runs: RunSummary[];
	nextCursor?: string;
	total: number;
};

export type AttemptSummary = {
	attemptId: AttemptId;
	ordinal: number;
	kind: "initial" | "retry" | "resume";
	createdAt: string;
};

export type RunInspection = {
	summary: RunSummary;
	plan: AgentLaunchPlan;
	attempts: AttemptSummary[];
	result?: AttemptExecutionResult;
};

export type RunLogPage = {
	events: JournalEvent[];
	nextCursor?: string;
	total: number;
};

export type RunObservation = {
	runId: RunId;
	status: RunStatus;
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
	listRuns(query?: Omit<RunQuery, "ownerId">): Promise<RunPage>;
	logs(
		runId: RunId,
		options?: { cursor?: string; limit?: number; tail?: number },
	): Promise<RunLogPage>;
	wait(runId: RunId): Promise<AttemptExecutionResult>;
	interrupt(runId: RunId): Promise<RunReceipt>;
	steer(runId: RunId, input: ControlInput): Promise<ControlReceipt>;
	followUp(runId: RunId, input: ControlInput): Promise<ControlReceipt>;
	retry(runId: RunId): Promise<RunReceipt>;
	resume(runId: RunId): Promise<RunReceipt>;
	reconcile(runId: RunId): Promise<ReconcileResult>;
	release(runId: RunId): Promise<RunReceipt>;
	pin(runId: RunId, reason: string): Promise<RetentionPin>;
	unpin(runId: RunId): Promise<boolean>;
	exportArtifact(
		runId: RunId,
		ref: ArtifactRef,
		maxBytes?: number,
	): Promise<ArtifactExport>;
};

export type SubagentService = {
	forOwner(owner: OwnerRegistration): SubagentClient;
	listRuns(query?: RunQuery): Promise<RunPage>;
	inspectRun(runId: RunId): Promise<RunInspection>;
	runLogs(
		runId: RunId,
		options?: { cursor?: string; limit?: number; tail?: number },
	): Promise<RunLogPage>;
	subscribe(listener: (event: RunObservation) => void): () => void;
	prune(options?: {
		dryRun?: boolean;
		maxAgeMs?: number;
		maxBytes?: number;
	}): Promise<RetentionReport>;
	shutdown(): Promise<void>;
};

type PreparedPreflight = SubagentPreflight & {
	ownerId: string;
	requestSha256: string;
	agent: DiscoveredAgent;
	workspace: WorkspacePreflight;
	skills: SkillProjection;
	contextFiles: ContextFileProjection;
	forkContext?: ForkContextProjection;
};

type ActiveRun = {
	ownerId: string;
	plan: AgentLaunchPlan;
	workspace: WorkspacePreflight;
	skills: SkillProjection;
	contextFiles: ContextFileProjection;
	forkContext?: ForkContextProjection;
	journal: RunJournal;
	artifacts: ArtifactStore;
	abort: AbortController;
	promise: Promise<AttemptExecutionResult>;
	result?: AttemptExecutionResult;
	status: RunStatus;
	createdAt: string;
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

export class RetryBackoffError extends Error {
	constructor(readonly retryAt: string) {
		super(`retry backoff remains active until ${retryAt}`);
		this.name = "RetryBackoffError";
	}
}

function retryDelayMs(failure: RunResult["failure"], ordinal: number): number {
	if (failure?.retry !== "backoff") return 0;
	return Math.min(
		300_000,
		(failure.retryAfterMs ?? 1_000) * 2 ** Math.min(ordinal, 8),
	);
}

function retryPlan(
	current: AgentLaunchPlan,
	result: AttemptExecutionResult,
	ordinal: number,
): AgentLaunchPlan {
	if (current.limits.retries < 1) throw new Error("retry budget exhausted");
	if (
		result.result.failure?.retry !== "manual" &&
		result.result.failure?.retry !== "backoff"
	) {
		throw new Error("failure classification does not permit retry");
	}
	const remainingRuntimeMs = current.limits.runtimeMs - result.result.runtimeMs;
	const remainingTokens =
		current.limits.tokens - result.result.usage.totalTokens;
	const remainingCost = current.limits.cost - result.result.usage.cost;
	if (remainingRuntimeMs < 1_000 || remainingTokens < 1 || remainingCost <= 0) {
		throw new Error("retry run-wide budget exhausted");
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
			runtimeMs: remainingRuntimeMs,
			attemptRuntimeMs: Math.min(
				current.limits.attemptRuntimeMs,
				remainingRuntimeMs,
			),
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
	if (result.result.failure?.retry !== "resume") {
		throw new Error("failure classification does not permit resume");
	}
	const remainingRuntimeMs = current.limits.runtimeMs - result.result.runtimeMs;
	const remainingTokens =
		current.limits.tokens - result.result.usage.totalTokens;
	const remainingCost = current.limits.cost - result.result.usage.cost;
	if (remainingRuntimeMs < 1_000 || remainingTokens < 1 || remainingCost <= 0) {
		throw new Error("resume run-wide budget exhausted");
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
			runtimeMs: remainingRuntimeMs,
			attemptRuntimeMs: Math.min(
				current.limits.attemptRuntimeMs,
				remainingRuntimeMs,
			),
			tokens: remainingTokens,
			cost: remainingCost,
			resumes: current.limits.resumes - 1,
		},
	};
	return { ...draft, identitySha256: canonicalSha256(draft) };
}

type SessionEvidence =
	| { state: "absent" }
	| { state: "valid"; file: string; sessionId: string }
	| { state: "unknown" };

async function observeSessionEvidence(
	root: string,
	events: JournalEvent[],
	preferredFile?: string,
): Promise<SessionEvidence> {
	const event = [...events]
		.reverse()
		.find((candidate) => candidate.type === "session-started");
	const data = event?.data as
		| { sessionId?: unknown; sessionFile?: unknown }
		| undefined;
	const sessionId = data?.sessionId;
	const candidateFile = preferredFile ?? data?.sessionFile;
	if (typeof sessionId !== "string" || typeof candidateFile !== "string") {
		return { state: "absent" };
	}
	try {
		const sessionsRoot = await realpath(path.join(root, "sessions"));
		const file = await realpath(candidateFile);
		if (!isInsidePath(sessionsRoot, file)) return { state: "unknown" };
		const manager = SessionManager.open(file);
		return manager.getSessionId() === sessionId
			? { state: "valid", file, sessionId }
			: { state: "unknown" };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { state: "absent" };
		}
		return { state: "unknown" };
	}
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

function agentFromPlan(plan: AgentLaunchPlan): DiscoveredAgent {
	return {
		name: plan.agent,
		displayName: plan.agentDisplayName,
		prompt: plan.agentPrompt,
		scope: plan.agentScope,
		source: plan.agentSource,
		sha256: plan.agentSha256,
		defaultModel: plan.model,
		allowedModels: [
			`${plan.model.provider}/${plan.model.id}:${plan.model.thinking}`,
		],
		tools: [...plan.tools],
		preloadSkills: [...plan.preloadSkills],
		contextScopes: [...plan.contextScopes],
		workspaceModes: [plan.workspace.mode],
		limitCeiling: { ...plan.limits },
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
	skills: SkillProjection,
	contextFiles: ContextFileProjection,
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
	for (const contextFile of contextFiles.files) {
		resources.push(contextFile.grant);
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

export type SubagentExecutionDependencies = {
	modelRuntime: ModelRuntime;
	capacity: VmCapacityManager;
	sandbox: ResolvedSandbox;
};

export async function createSubagentService(options: {
	root: string;
	agents: Map<string, DiscoveredAgent>;
	modelRuntime?: ModelRuntime;
	capacity?: VmCapacityManager;
	sandbox?: ResolvedSandbox;
	loadExecution?: () => Promise<SubagentExecutionDependencies>;
	preflightTtlMs?: number;
	agentDir?: string;
	isProjectTrusted?: (cwd: string) => boolean;
	resolveModel?: (model: ExactModelRequest) => Promise<ExactModelRequest>;
	executeAttempt?: AttemptExecutor;
	processController?: ProcessController;
}): Promise<SubagentService> {
	await mkdir(options.root, { recursive: true, mode: 0o700 });
	const builtToolImplementation = fileURLToPath(
		new URL("./sandbox/tools.js", import.meta.url),
	);
	const sourceToolImplementation = fileURLToPath(
		new URL("./sandbox/tools.ts", import.meta.url),
	);
	const toolImplementationPath = await access(builtToolImplementation)
		.then(() => builtToolImplementation)
		.catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return sourceToolImplementation;
			throw error;
		});
	const toolImplementation = await digestFileResource(toolImplementationPath);
	const operationIndex = await OperationIndex.open(
		path.join(options.root, "operations"),
	);
	const runRecords = await RunRecordStore.open(
		path.join(options.root, "run-records"),
	);
	const attemptRecords = await AttemptRecordStore.open(
		path.join(options.root, "attempt-records"),
	);
	const retention = await createRetentionManager({ root: options.root });
	const preflights = new Map<string, PreparedPreflight>();
	const runs = new Map<string, ActiveRun>();
	const observers = new Set<(event: RunObservation) => void>();
	const emit = (runId: RunId, status: RunStatus) => {
		for (const observer of observers) {
			try {
				observer({ runId, status });
			} catch {
				// Observation must not alter lifecycle authority.
			}
		}
	};
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
	const processController =
		options.processController ?? createHostProcessController();
	let executionPromise: Promise<SubagentExecutionDependencies> | undefined;
	const execution = () => {
		if (!executionPromise) {
			executionPromise = (
				options.loadExecution
					? options.loadExecution()
					: options.modelRuntime && options.capacity && options.sandbox
						? Promise.resolve({
								modelRuntime: options.modelRuntime,
								capacity: options.capacity,
								sandbox: options.sandbox,
							})
						: Promise.reject(
								new Error("execution dependencies are unavailable"),
							)
			).catch((error) => {
				executionPromise = undefined;
				throw error;
			});
		}
		return executionPromise;
	};
	const resolveModel =
		options.resolveModel ??
		(async (model: ExactModelRequest) =>
			createExactModelResolver((await execution()).modelRuntime)(model));

	for (const record of await runRecords.list()) {
		const recoveredSkills: SkillProjection = {
			catalog: [],
			preloadPrompt: "",
		};
		const recoveredContextFiles: ContextFileProjection = { files: [] };
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
					runtimeMs: 0,
					failure: {
						code: "unknown",
						origin: "service",
						retry: "reconcile",
						message: "Terminal state was not proved before seat loss",
						guidance: "Reconcile external state before continuing.",
					},
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
			let recoveredHandoff: WorktreeRecord | undefined;
			if (latestAttempt?.worktreeAttemptId) {
				try {
					recoveredHandoff = await readWorktreeRecord(
						path.join(
							options.root,
							"workspace",
							"records",
							`${latestAttempt.worktreeAttemptId}.json`,
						),
					);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
			}
			const execution: AttemptExecutionResult = {
				result,
				output: typeof state?.output === "string" ? state.output : "",
				sessionFile:
					typeof state?.sessionFile === "string"
						? state.sessionFile
						: undefined,
				handoff: recoveredHandoff,
				structuredOutput: result.structuredOutput,
				error: typeof state?.error === "string" ? state.error : undefined,
			};
			const abort = new AbortController();
			const active: ActiveRun = {
				ownerId: record.ownerId,
				plan: recoveredPlan,
				workspace: record.workspace,
				skills: recoveredSkills,
				contextFiles: recoveredContextFiles,
				journal,
				artifacts,
				abort,
				promise: Promise.resolve(execution),
				result: execution,
				status: result.status,
				createdAt: record.createdAt,
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
		contextFiles: ContextFileProjection;
		forkContext?: ForkContextProjection;
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
			const runRecord =
				input.kind === "initial"
					? await runRecords.create(
							input.ownerId,
							input.rootPlan,
							input.workspace,
						)
					: await runRecords.read(input.plan.runId);
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
				lease,
				ordinal: input.ordinal,
				kind: input.kind,
				...(input.parentAttemptId
					? { parentAttemptId: input.parentAttemptId }
					: {}),
				...(worktree ? { worktreeAttemptId: worktree.attemptId } : {}),
			});
			const executionDependencies = await execution();
			const abort = new AbortController();
			let active: ActiveRun | undefined;
			let pendingControl: AttemptControl | undefined;
			const rawPromise = executeAttempt({
				plan: input.plan,
				agent: input.agent,
				workspacePath,
				workspaceAliases: [input.workspace.cwd],
				...(worktree ? { worktree } : {}),
				modelRuntime: executionDependencies.modelRuntime,
				capacity: executionDependencies.capacity,
				lease,
				journal,
				artifactStore: artifacts,
				skills: input.skills,
				contextFiles: input.contextFiles,
				...(input.forkContext ? { forkContext: input.forkContext } : {}),
				sessionRoot: path.join(options.root, "sessions"),
				...(input.resumeSessionFile
					? { resumeSessionFile: input.resumeSessionFile }
					: {}),
				registerControl(control) {
					pendingControl = control;
					if (active && control) active.control = control;
					else if (active) delete active.control;
					if (active) emit(active.plan.runId, active.status);
				},
				signal: abort.signal,
			});
			active = {
				ownerId: input.ownerId,
				plan: input.plan,
				workspace: input.workspace,
				skills: input.skills,
				contextFiles: input.contextFiles,
				...(input.forkContext ? { forkContext: input.forkContext } : {}),
				journal,
				artifacts,
				abort,
				promise: rawPromise,
				status: "active",
				createdAt: runRecord.createdAt,
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
							emit(running.plan.runId, running.status);
							throw error;
						}
					}
					emit(running.plan.runId, running.status);
					return result;
				},
				(error: unknown) => {
					running.status = "cleanup-blocked";
					emit(running.plan.runId, running.status);
					throw error;
				},
			);
			runs.set(input.plan.runId, running);
			emit(input.plan.runId, "active");
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

	const retainedWorktree = async (
		run: ActiveRun,
		attempts?: Awaited<ReturnType<AttemptRecordStore["list"]>>,
	): Promise<boolean> => {
		const records = attempts ?? (await attemptRecords.list(run.plan.runId));
		for (const attempt of records) {
			const worktreeAttemptId = attempt.worktreeAttemptId;
			if (!worktreeAttemptId) continue;
			try {
				const record = await readWorktreeRecord(
					path.join(
						options.root,
						"workspace",
						"records",
						`${worktreeAttemptId}.json`,
					),
				);
				if (!record.releasedAt) return true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
				throw error;
			}
		}
		return false;
	};

	const summarizeRun = async (
		run: ActiveRun,
		pinnedRuns: Set<RunId>,
	): Promise<RunSummary> => {
		const [attempts, events] = await Promise.all([
			attemptRecords.list(run.plan.runId),
			run.journal.readEvents(),
		]);
		const latestAttempt = attempts.at(-1);
		const updatedAt = events.at(-1)?.timestamp ?? run.createdAt;
		const retryFailure = run.result?.result.failure;
		const retryTerminal = events.findLast(
			(event) => event.type === "attempt-failed",
		);
		const retryDelay = retryDelayMs(retryFailure, latestAttempt?.ordinal ?? 0);
		const retryAt =
			retryDelay > 0 && retryTerminal
				? new Date(
						Date.parse(retryTerminal.timestamp) + retryDelay,
					).toISOString()
				: undefined;
		const remainingRuntime =
			run.plan.limits.runtimeMs - (run.result?.result.runtimeMs ?? 0);
		const remainingTokens =
			run.plan.limits.tokens - (run.result?.result.usage.totalTokens ?? 0);
		const remainingCost =
			run.plan.limits.cost - (run.result?.result.usage.cost ?? 0);
		const goalPreview = run.plan.task.goal
			.replaceAll(/\s+/g, " ")
			.slice(0, 240);
		return {
			runId: run.plan.runId,
			attemptId: latestAttempt?.attemptId ?? run.plan.attemptId,
			ownerId: run.ownerId,
			agentName: run.plan.agent,
			agentDisplayName: run.plan.agentDisplayName,
			goalPreview,
			status: run.status,
			repositoryRoot: run.workspace.repositoryRoot,
			workspaceMode: run.plan.workspace.mode,
			createdAt: run.createdAt,
			updatedAt,
			...(run.result ? { usage: run.result.result.usage } : {}),
			pinned: pinnedRuns.has(run.plan.runId),
			controllable: run.status === "active" && run.control !== undefined,
			retryable:
				run.status === "failed" &&
				run.result !== undefined &&
				(retryFailure?.retry === "manual" ||
					retryFailure?.retry === "backoff") &&
				run.plan.limits.retries > 0 &&
				remainingRuntime >= 1_000 &&
				remainingTokens >= 1 &&
				remainingCost > 0,
			...(retryAt ? { retryAt } : {}),
			resumable:
				run.status === "interrupted" &&
				run.result?.sessionFile !== undefined &&
				run.result.result.failure?.retry === "resume" &&
				run.plan.limits.resumes > 0 &&
				remainingRuntime >= 1_000 &&
				remainingTokens >= 1 &&
				remainingCost > 0,
			retainedWorktree: await retainedWorktree(run, attempts),
			requiresAttention: [
				"active",
				"stopping",
				"interrupted",
				"cleanup-blocked",
			].includes(run.status),
		};
	};

	const retentionRuns = async (): Promise<RetentionRun[]> => {
		const descriptors: RetentionRun[] = [];
		for (const run of runs.values()) {
			const attempts = await attemptRecords.list(run.plan.runId);
			const hasRetainedWorktree = await retainedWorktree(run, attempts);
			const events = await run.journal.readEvents();
			const terminalEvent = events.findLast((event) =>
				[
					"attempt-completed",
					"attempt-failed",
					"run-reconciled",
					"startup-reconciled",
				].includes(event.type),
			);
			descriptors.push({
				runId: run.plan.runId,
				status: run.status,
				...(terminalEvent ? { terminalAt: terminalEvent.timestamp } : {}),
				attemptIds: attempts.map((attempt) => attempt.attemptId),
				worktreeAttemptIds: [
					...new Set(
						attempts
							.map((attempt) => attempt.worktreeAttemptId)
							.filter(
								(attemptId): attemptId is string => attemptId !== undefined,
							),
					),
				],
				retainedWorktree: hasRetainedWorktree,
			});
		}
		return descriptors;
	};

	const readLogs = async (
		run: ActiveRun,
		logOptions: { cursor?: string; limit?: number; tail?: number } = {},
	): Promise<RunLogPage> => {
		if (logOptions.cursor !== undefined && logOptions.tail !== undefined) {
			throw new Error("log cursor and tail are mutually exclusive");
		}
		const limit = logOptions.limit ?? logOptions.tail ?? 100;
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
			throw new Error("log limit must be an integer from 1 to 500");
		}
		const events = await run.journal.readEvents();
		let offset = 0;
		if (logOptions.tail !== undefined) {
			if (
				!Number.isSafeInteger(logOptions.tail) ||
				logOptions.tail < 1 ||
				logOptions.tail > 500
			) {
				throw new Error("log tail must be an integer from 1 to 500");
			}
			offset = Math.max(0, events.length - logOptions.tail);
		} else if (logOptions.cursor !== undefined) {
			offset = Number(logOptions.cursor);
			if (
				!Number.isSafeInteger(offset) ||
				offset < 0 ||
				String(offset) !== logOptions.cursor
			) {
				throw new Error("invalid log cursor");
			}
		}
		const page = events.slice(offset, offset + limit);
		const nextOffset = offset + page.length;
		return {
			events: page,
			...(nextOffset < events.length ? { nextCursor: String(nextOffset) } : {}),
			total: events.length,
		};
	};

	const listRuns = async (query: RunQuery = {}): Promise<RunPage> => {
		const limit = query.limit ?? 50;
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
			throw new Error("run list limit must be an integer from 1 to 100");
		}
		const offset = query.cursor === undefined ? 0 : Number(query.cursor);
		if (
			!Number.isSafeInteger(offset) ||
			offset < 0 ||
			(query.cursor !== undefined && String(offset) !== query.cursor)
		) {
			throw new Error("invalid run list cursor");
		}
		const validStatuses = new Set<RunStatus>([
			"queued",
			"active",
			"stopping",
			"completed",
			"failed",
			"cancelled",
			"interrupted",
			"cleanup-blocked",
		]);
		if (query.statuses?.some((status) => !validStatuses.has(status))) {
			throw new Error("invalid run status filter");
		}
		const pins = new Set((await retention.listPins()).map((pin) => pin.runId));
		let summaries = await Promise.all(
			[...runs.values()]
				.filter(
					(run) =>
						(query.repositoryRoot === undefined ||
							run.workspace.repositoryRoot === query.repositoryRoot) &&
						(query.ownerId === undefined || run.ownerId === query.ownerId) &&
						(query.statuses === undefined ||
							query.statuses.includes(run.status)),
				)
				.map((run) => summarizeRun(run, pins)),
		);
		const search = query.search?.trim().toLowerCase();
		if (search) {
			if (Buffer.byteLength(search) > 512) {
				throw new Error("run search exceeds byte limit");
			}
			summaries = summaries.filter((run) =>
				[
					run.runId,
					run.agentDisplayName,
					run.goalPreview,
					run.repositoryRoot,
					run.status,
				]
					.join("\n")
					.toLowerCase()
					.includes(search),
			);
		}
		const priority: Record<RunStatus, number> = {
			active: 0,
			stopping: 1,
			"cleanup-blocked": 2,
			interrupted: 3,
			failed: 4,
			cancelled: 5,
			completed: 6,
			queued: 7,
		};
		summaries.sort(
			(left, right) =>
				priority[left.status] - priority[right.status] ||
				Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
				left.runId.localeCompare(right.runId),
		);
		const page = summaries.slice(offset, offset + limit);
		const nextOffset = offset + page.length;
		return {
			runs: page,
			...(nextOffset < summaries.length
				? { nextCursor: String(nextOffset) }
				: {}),
			total: summaries.length,
		};
	};

	return {
		subscribe(listener) {
			observers.add(listener);
			return () => observers.delete(listener);
		},

		listRuns,

		async inspectRun(runId) {
			const run = runs.get(runId);
			if (!run) throw new Error("run not found");
			const pins = new Set(
				(await retention.listPins(runId)).map((pin) => pin.runId),
			);
			const attempts = await attemptRecords.list(runId);
			return {
				summary: await summarizeRun(run, pins),
				plan: run.plan,
				attempts: attempts.map((attempt) => ({
					attemptId: attempt.attemptId,
					ordinal: attempt.ordinal,
					kind: attempt.kind,
					createdAt: attempt.createdAt,
				})),
				...(run.result ? { result: run.result } : {}),
			};
		},

		runLogs(runId, logOptions) {
			const run = runs.get(runId);
			if (!run) throw new Error("run not found");
			return readLogs(run, logOptions);
		},

		async prune(pruneOptions = {}) {
			return runExclusive(async () => {
				const report = await retention.prune({
					runs: await retentionRuns(),
					dryRun: pruneOptions.dryRun ?? true,
					...(pruneOptions.maxAgeMs === undefined
						? {}
						: { maxAgeMs: pruneOptions.maxAgeMs }),
					...(pruneOptions.maxBytes === undefined
						? {}
						: { maxBytes: pruneOptions.maxBytes }),
				});
				if (!report.dryRun) {
					const removedRunIds = new Set([
						...report.pruned.map((item) => item.runId),
						...report.recoveredTrashIntents,
					]);
					for (const runId of removedRunIds) runs.delete(runId);
					for (const [preflightId, prepared] of preflights) {
						if (removedRunIds.has(prepared.launchPlan.runId)) {
							preflights.delete(preflightId);
						}
					}
				}
				return report;
			});
		},

		async shutdown() {
			const pending: Promise<unknown>[] = [];
			for (const run of runs.values()) {
				if (run.status !== "active" && run.status !== "stopping") continue;
				run.status = "stopping";
				emit(run.plan.runId, run.status);
				run.abort.abort("seat-shutdown");
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
					const projectTrusted =
						options.isProjectTrusted?.(workspace.cwd) ?? false;
					const skills = await discoverAndProjectSkills({
						cwd: workspace.cwd,
						agentDir,
						projectTrusted,
						preloadSkills: [
							...new Set([...agent.preloadSkills, ...request.preloadSkills]),
						],
					});
					const contextFiles = await discoverAndProjectContextFiles({
						cwd: workspace.cwd,
						workspaceRoot: workspace.repositoryRoot,
						agentDir,
						projectTrusted,
						scopes: [
							...new Set([...agent.contextScopes, ...request.contextScopes]),
						],
					});
					let forkContext: ForkContextProjection | undefined;
					if (request.contextMode === "fork") {
						if (!owner.parentSessionId || !owner.parentSessionFile) {
							throw new Error(
								"fork context requires an authorized parent session",
							);
						}
						forkContext = await projectForkContext({
							parentSessionId: owner.parentSessionId,
							parentSessionFile: owner.parentSessionFile,
						});
					}
					const ids = deterministicIds(owner.id, request);
					const executionDependencies = await execution();
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
							contextFiles,
						),
						contextResources: contextFiles.files.map((file) => file.grant),
						workspace,
						sandbox: executionDependencies.sandbox,
						...(forkContext ? { forkContext: forkContext.grant } : {}),
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
						contextFiles,
						...(forkContext ? { forkContext } : {}),
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
					const currentContextFiles = await discoverAndProjectContextFiles({
						cwd: currentWorkspace.cwd,
						workspaceRoot: currentWorkspace.repositoryRoot,
						agentDir,
						projectTrusted:
							options.isProjectTrusted?.(currentWorkspace.cwd) ?? false,
						scopes: prepared.launchPlan.contextScopes,
					});
					assertContextFileProjection(prepared.launchPlan, currentContextFiles);
					prepared.contextFiles = currentContextFiles;
					if (prepared.launchPlan.contextMode === "fork") {
						if (!owner.parentSessionId || !owner.parentSessionFile) {
							throw new Error("fork context authorization was lost");
						}
						const currentFork = await projectForkContext({
							parentSessionId: owner.parentSessionId,
							parentSessionFile: owner.parentSessionFile,
						});
						if (
							canonicalSha256(currentFork.grant) !==
							canonicalSha256(prepared.launchPlan.forkContext)
						) {
							throw new Error("fork context changed after preflight");
						}
						prepared.forkContext = currentFork;
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
						return startAttempt({
							ownerId: owner.id,
							plan: prepared.launchPlan,
							agent: prepared.agent,
							workspace: prepared.workspace,
							skills: prepared.skills,
							contextFiles: prepared.contextFiles,
							...(prepared.forkContext
								? { forkContext: prepared.forkContext }
								: {}),
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

				listRuns(query = {}) {
					return listRuns({ ...query, ownerId: owner.id });
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

				logs(runId, logOptions) {
					return readLogs(ownedRun(runId), logOptions);
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
						if (
							run.result.result.failure?.retry !== "manual" &&
							run.result.result.failure?.retry !== "backoff"
						) {
							throw new Error("failure classification does not permit retry");
						}
						const latest = await attemptRecords.latest(runId);
						if (!latest || latest.attemptId !== run.plan.attemptId) {
							throw new Error("attempt history mismatch");
						}
						const retryDelay = retryDelayMs(
							run.result.result.failure,
							latest.ordinal,
						);
						if (retryDelay > 0) {
							const terminalEvent = (await run.journal.readEvents()).findLast(
								(event) => event.type === "attempt-failed",
							);
							if (!terminalEvent) {
								throw new Error("retry terminal evidence is unavailable");
							}
							const retryAt = new Date(
								Date.parse(terminalEvent.timestamp) + retryDelay,
							);
							if (retryAt.getTime() > Date.now()) {
								throw new RetryBackoffError(retryAt.toISOString());
							}
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
						const agent =
							options.agents.get(run.plan.agent) ?? agentFromPlan(run.plan);
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
						const contextFiles = await discoverAndProjectContextFiles({
							cwd: workspace.cwd,
							workspaceRoot: workspace.repositoryRoot,
							agentDir,
							projectTrusted:
								options.isProjectTrusted?.(workspace.cwd) ?? false,
							scopes: run.plan.contextScopes,
						});
						assertContextFileProjection(run.plan, contextFiles);
						let forkContext: ForkContextProjection | undefined;
						if (run.plan.contextMode === "fork") {
							if (!owner.parentSessionId || !owner.parentSessionFile) {
								throw new Error(
									"fork retry requires the authorized parent session",
								);
							}
							forkContext = await projectForkContext({
								parentSessionId: owner.parentSessionId,
								parentSessionFile: owner.parentSessionFile,
							});
							if (
								canonicalSha256(forkContext.grant) !==
								canonicalSha256(run.plan.forkContext)
							) {
								throw new Error("fork context changed before retry");
							}
						}
						const plan = retryPlan(run.plan, run.result, latest.ordinal + 1);
						return startAttempt({
							ownerId: owner.id,
							plan,
							agent,
							workspace,
							skills,
							contextFiles,
							...(forkContext ? { forkContext } : {}),
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
						if (run.result.result.failure?.retry !== "resume") {
							throw new Error("failure classification does not permit resume");
						}
						const latest = await attemptRecords.latest(runId);
						if (!latest || latest.attemptId !== run.plan.attemptId) {
							throw new Error("attempt history mismatch");
						}
						const rootRecord = await runRecords.read(runId);
						const sessionEvidence = await observeSessionEvidence(
							options.root,
							await run.journal.readEvents(),
							run.result.sessionFile,
						);
						if (sessionEvidence.state !== "valid") {
							throw new Error("retained session identity is unproved");
						}
						const sessionFile = sessionEvidence.file;
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
						const agent =
							options.agents.get(run.plan.agent) ?? agentFromPlan(run.plan);
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
						const contextFiles = await discoverAndProjectContextFiles({
							cwd: workspace.cwd,
							workspaceRoot: workspace.repositoryRoot,
							agentDir,
							projectTrusted:
								options.isProjectTrusted?.(workspace.cwd) ?? false,
							scopes: run.plan.contextScopes,
						});
						assertContextFileProjection(run.plan, contextFiles);
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
							contextFiles,
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
						const sandboxData = sandboxEvent?.data as
							| {
									hostPid?: unknown;
									hostProcessIdentity?: unknown;
							  }
							| undefined;
						const recordedIdentity = sandboxData?.hostProcessIdentity as
							| Partial<ProcessIdentity>
							| undefined;
						let sandboxProcess: ReconcileResult["sandboxProcess"];
						if (sandboxEvent === undefined) {
							sandboxProcess = "not-started";
						} else if (
							typeof sandboxData?.hostPid !== "number" ||
							recordedIdentity?.pid !== sandboxData.hostPid ||
							typeof recordedIdentity.startedAtMs !== "number" ||
							typeof recordedIdentity.commandSha256 !== "string" ||
							!/^[a-f0-9]{64}$/.test(recordedIdentity.commandSha256)
						) {
							sandboxProcess = "unknown";
						} else {
							const identity = recordedIdentity as ProcessIdentity;
							const observation = await processController.observe(identity.pid);
							if (observation.state === "absent") {
								sandboxProcess = "absent";
							} else if (
								observation.state === "present" &&
								processIdentitiesEqual(observation.identity, identity)
							) {
								sandboxProcess = await processController.terminate(identity);
							} else {
								sandboxProcess = "unknown";
							}
						}
						const latestAttempt = await attemptRecords.latest(runId);
						let workspace: ReconcileResult["workspace"];
						if (run.plan.workspace.mode === "read-only") {
							workspace = "not-needed";
						} else if (!latestAttempt?.worktreeAttemptId) {
							workspace = "unknown";
						} else {
							try {
								const record = await readWorktreeRecord(
									path.join(
										options.root,
										"workspace",
										"records",
										`${latestAttempt.worktreeAttemptId}.json`,
									),
								);
								if (
									record.runId !== runId ||
									record.attemptId !== latestAttempt.worktreeAttemptId
								) {
									workspace = "unknown";
								} else {
									const observation = await observeWorktree(record);
									workspace =
										observation.state === "absent"
											? "absent"
											: observation.state === "unknown"
												? "unknown"
												: "retained";
								}
							} catch {
								workspace = "unknown";
							}
						}
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
						const sessionEvidence = await observeSessionEvidence(
							options.root,
							events,
							run.result?.sessionFile,
						);
						const sessionFile =
							sessionEvidence.state === "valid"
								? sessionEvidence.file
								: undefined;
						const canClassify =
							(sandboxCleanup === "proved" ||
								sandboxCleanup === "not-needed") &&
							workspaceCleanup !== "unknown" &&
							sessionEvidence.state !== "unknown";
						const status: RunResult["status"] = canClassify
							? sessionEvidence.state === "valid"
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
							runtimeMs: run.result?.result.runtimeMs ?? 0,
							failure:
								status === "interrupted"
									? {
											code: "seat-interruption",
											origin: "service",
											retry: "resume",
											message: "Prior attempt ended before terminal proof",
											guidance:
												"Resume the retained session in a fresh VM after validation.",
										}
									: status === "cleanup-blocked"
										? {
												code: "sandbox-cleanup",
												origin: "service",
												retry: "reconcile",
												message: "External cleanup remains unproved",
												guidance:
													"Reconcile recorded sandbox and workspace identities.",
											}
										: {
												code: "unknown",
												origin: "service",
												retry: "reconcile",
												message: "Prior attempt failed without terminal proof",
												guidance:
													"Inspect lifecycle evidence before continuing.",
											},
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
						emit(runId, run.status);
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
								emit(runId, run.status);
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

				async pin(runId, reason) {
					ownedRun(runId);
					return retention.pin(owner.id, runId, reason);
				},

				async unpin(runId) {
					ownedRun(runId);
					return retention.unpin(owner.id, runId);
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
						emit(runId, run.status);
						run.abort.abort("caller-interrupt");
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
