import path from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import type { ArtifactStore } from "../artifacts/store.js";
import {
	type ArtifactRef,
	type ClassifiedFailure,
	isRunResult,
	type RunResult,
	type Usage,
} from "../contracts.js";
import {
	type AgentLaunchPlan,
	AgentLaunchPlanSchema,
} from "../launch-contracts.js";
import type { RunJournal } from "../persistence/journal.js";
import type { RunLease } from "../persistence/run-lease.js";
import type { DiscoveredAgent } from "../preflight/agents.js";
import { canonicalJson, canonicalSha256 } from "../preflight/canonical.js";
import { verifyLaunchPlanIdentity } from "../preflight/compile.js";
import type { ForkContextProjection } from "../preflight/context.js";
import {
	assertContextFileProjection,
	type ContextFileProjection,
} from "../preflight/context-files.js";
import { resolveExactPiModel } from "../preflight/models.js";
import type { SkillProjection } from "../preflight/skills.js";
import type { VmCapacityManager } from "../sandbox/capacity.js";
import {
	createGondolinAttemptSandbox,
	type GondolinAttemptSandbox,
} from "../sandbox/gondolin.js";
import { GUEST_WORKSPACE } from "../sandbox/tools.js";
import {
	finalizeWorktreeHandoff,
	type WorktreeRecord,
} from "../workspace/worktree.js";
import {
	type BudgetSteeringStage,
	type BudgetSteeringTrigger,
	budgetStagesForPressure,
	budgetSteeringMessage,
	uncachedTokens,
} from "./budget.js";
import { classifyAttemptFailure } from "./failure.js";
import { createFinalAnswerController } from "./structured-output.js";

const MAX_INLINE_OUTPUT_BYTES = 32 * 1024;

export type AttemptControl = {
	steer(text: string): Promise<void>;
	followUp(text: string): Promise<void>;
};

export type AttemptExecutionResult = {
	result: RunResult;
	output: string;
	sessionFile: string | undefined;
	handoff: WorktreeRecord | undefined;
	structuredOutput: unknown | undefined;
	error: string | undefined;
};

function assistantOutput(session: AgentSession, firstMessageIndex = 0): string {
	for (
		let index = session.messages.length - 1;
		index >= firstMessageIndex;
		index--
	) {
		const message = session.messages[index];
		if (message?.role !== "assistant") continue;
		return message.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("");
	}
	return "";
}

export function boundAttemptOutput(
	output: string,
	limit: number,
): { output: string; truncated: boolean } {
	const content = Buffer.from(output, "utf8");
	if (content.byteLength <= limit) return { output, truncated: false };
	let bytes = 0;
	let bounded = "";
	for (const character of output) {
		const characterBytes = Buffer.byteLength(character, "utf8");
		if (bytes + characterBytes > limit) break;
		bounded += character;
		bytes += characterBytes;
	}
	return { output: bounded, truncated: true };
}

function usage(session: AgentSession): Usage {
	const total: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: 0,
	};
	for (const message of session.messages) {
		if (message.role !== "assistant") continue;
		total.input += message.usage.input;
		total.output += message.usage.output;
		total.cacheRead += message.usage.cacheRead;
		total.cacheWrite += message.usage.cacheWrite;
		total.totalTokens += message.usage.totalTokens;
		total.cost += message.usage.cost.total;
	}
	return total;
}

export function subtractUsage(total: Usage, baseline: Usage): Usage {
	return {
		input: Math.max(0, total.input - baseline.input),
		output: Math.max(0, total.output - baseline.output),
		cacheRead: Math.max(0, total.cacheRead - baseline.cacheRead),
		cacheWrite: Math.max(0, total.cacheWrite - baseline.cacheWrite),
		totalTokens: Math.max(0, total.totalTokens - baseline.totalTokens),
		cost: Math.max(0, total.cost - baseline.cost),
	};
}

function delegatedPrompt(plan: AgentLaunchPlan): string {
	return [
		`Goal:\n${plan.task.goal}`,
		plan.task.context.length > 0
			? `Context:\n${plan.task.context.map((item) => `- ${item}`).join("\n")}`
			: undefined,
		`Instructions:\n${plan.task.instructions.map((item) => `- ${item}`).join("\n")}`,
	]
		.filter((section): section is string => section !== undefined)
		.join("\n\n");
}

function terminalResult(input: {
	plan: AgentLaunchPlan;
	status: RunResult["status"];
	usage: Usage;
	usageComplete: boolean;
	runtimeMs: number;
	failure?: ClassifiedFailure;
	sandboxCleanup: RunResult["sandboxCleanup"];
	workspaceCleanup: RunResult["workspaceCleanup"];
	truncated: boolean;
	output?: ArtifactRef;
	structuredOutput?: unknown;
}): RunResult {
	const result: RunResult = {
		runId: input.plan.runId,
		status: input.status,
		...(input.output ? { output: input.output } : {}),
		...(input.structuredOutput !== undefined
			? { structuredOutput: input.structuredOutput }
			: {}),
		usage: input.usage,
		usageComplete: input.usageComplete,
		runtimeMs: input.runtimeMs,
		...(input.failure ? { failure: input.failure } : {}),
		sandboxCleanup: input.sandboxCleanup,
		workspaceCleanup: input.workspaceCleanup,
		truncated: input.truncated,
	};
	if (!isRunResult(result))
		throw new Error("attempt produced an invalid result");
	return result;
}

export async function runNativeAttempt(options: {
	plan: AgentLaunchPlan;
	agent: DiscoveredAgent;
	workspacePath: string;
	workspaceAliases?: string[];
	worktree?: WorktreeRecord;
	modelRuntime: ModelRuntime;
	capacity: VmCapacityManager;
	lease: RunLease;
	journal: RunJournal;
	artifactStore: ArtifactStore;
	skills: SkillProjection;
	contextFiles: ContextFileProjection;
	forkContext?: ForkContextProjection;
	sessionRoot: string;
	resumeSessionFile?: string;
	registerControl?: (control: AttemptControl | undefined) => void;
	signal?: AbortSignal;
}): Promise<AttemptExecutionResult> {
	const attemptStartedAt = performance.now();
	const elapsedRuntimeMs = () =>
		Math.max(0, Math.ceil(performance.now() - attemptStartedAt));
	if (!Value.Check(AgentLaunchPlanSchema, options.plan)) {
		throw new Error("invalid launch plan");
	}
	if (!verifyLaunchPlanIdentity(options.plan)) {
		throw new Error("launch plan identity mismatch");
	}
	if (
		options.lease.record.runId !== options.plan.runId ||
		options.journal.runId !== options.plan.runId
	) {
		throw new Error("attempt ownership mismatch");
	}
	assertContextFileProjection(options.plan, options.contextFiles);
	if (
		(options.plan.contextMode === "fork" && !options.forkContext) ||
		(options.plan.contextMode === "fresh" && options.forkContext) ||
		(options.forkContext &&
			canonicalSha256(options.forkContext.grant) !==
				canonicalSha256(options.plan.forkContext))
	) {
		throw new Error("fork context projection mismatch");
	}
	const finalAnswer =
		options.plan.outputSchema === undefined
			? undefined
			: createFinalAnswerController(options.plan.outputSchema);
	if (
		options.agent.name !== options.plan.agent ||
		options.agent.displayName !== options.plan.agentDisplayName ||
		options.agent.prompt !== options.plan.agentPrompt ||
		options.agent.source !== options.plan.agentSource ||
		options.agent.sha256 !== options.plan.agentSha256 ||
		options.agent.scope !== options.plan.agentScope ||
		!options.plan.resources.some(
			(resource) =>
				resource.kind === "agent" &&
				resource.name === options.agent.name &&
				resource.sha256 === options.agent.sha256,
		)
	) {
		throw new Error("attempt agent identity mismatch");
	}
	await options.lease.assertCurrent();
	await options.journal.append("attempt-starting", {
		attemptId: options.plan.attemptId,
		identitySha256: options.plan.identitySha256,
	});

	let sandbox: GondolinAttemptSandbox | undefined;
	let session: AgentSession | undefined;
	let handoff: WorktreeRecord | undefined;
	let sessionFile: string | undefined;
	let sandboxCleanup: RunResult["sandboxCleanup"] = "not-needed";
	let workspaceCleanup: RunResult["workspaceCleanup"] =
		options.plan.workspace.mode === "read-only" ? "not-needed" : "retained";
	let collectedUsage: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: 0,
	};
	let baselineUsage: Usage = { ...collectedUsage };
	let baselineMessageIndex = 0;
	let output = "";
	let outputRef: ArtifactRef | undefined;
	let structuredOutput: unknown | undefined;
	let truncated = false;
	let stopBudgetSteering: () => Promise<void> = async () => {};
	const timeoutSignal = AbortSignal.timeout(
		options.plan.limits.attemptRuntimeMs,
	);
	const fatalToolController = new AbortController();
	let fatalToolAbort = false;
	const runSignal = AbortSignal.any([
		timeoutSignal,
		fatalToolController.signal,
		...(options.signal ? [options.signal] : []),
	]);
	const abort = () => {
		void session?.abort();
		void sandbox?.cancel();
	};
	runSignal.addEventListener("abort", abort, { once: true });

	try {
		runSignal.throwIfAborted();
		const resolved = await resolveExactPiModel(
			options.modelRuntime,
			options.plan.model,
			runSignal,
		);
		if (options.plan.sandbox.memoryBytes % (1024 * 1024) !== 0) {
			throw new Error("sandbox memory must be whole MiB");
		}
		sandbox = await createGondolinAttemptSandbox({
			owner: `${options.plan.runId}/${options.plan.attemptId}`,
			workspace: options.workspacePath,
			readOnly: options.plan.workspace.mode === "read-only",
			workspaceWriteBytes: options.plan.limits.workspaceWriteBytes,
			capacity: options.capacity,
			memory: `${options.plan.sandbox.memoryBytes / (1024 * 1024)}M`,
			...(options.workspaceAliases
				? { workspaceAliases: options.workspaceAliases }
				: {}),
			skillMounts: options.skills.catalog.map((skill) => ({
				hostBaseDir: skill.hostBaseDir,
				guestBaseDir: skill.guestBaseDir,
			})),
			contextMounts: options.contextFiles.files.map((file) => ({
				guestFilePath: file.guestFilePath,
				content: file.content,
			})),
			onFatalToolAbort() {
				if (runSignal.aborted) return;
				fatalToolAbort = true;
				fatalToolController.abort("fatal-tool-abort");
			},
		});
		if (sandbox.record.packageVersion !== options.plan.sandbox.packageVersion) {
			throw new Error("Gondolin package version drift");
		}
		await options.journal.append("sandbox-started", sandbox.record);
		const settingsManager = SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false },
		});
		const loader = new DefaultResourceLoader({
			cwd: options.workspacePath,
			agentDir: getAgentDir(),
			settingsManager,
			noExtensions: true,
			noSkills: true,
			skillsOverride: (base) => ({
				skills: options.skills.catalog.map((skill) => skill.skill),
				diagnostics: base.diagnostics,
			}),
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			agentsFilesOverride: () => ({
				agentsFiles: options.contextFiles.files.map((file) => ({
					path: file.guestFilePath,
					content: file.content,
				})),
			}),
			systemPrompt: [
				options.agent.prompt,
				`Current working directory: ${GUEST_WORKSPACE} (Gondolin VM).`,
				options.skills.preloadPrompt || undefined,
			]
				.filter((section): section is string => section !== undefined)
				.join("\n\n"),
		});
		await loader.reload();
		const customTools = Object.values(sandbox.tools).map(
			(tool) => tool as unknown as ToolDefinition,
		);
		if (finalAnswer) customTools.push(finalAnswer.tool);
		const activeTools = finalAnswer
			? [...options.plan.tools, "final_answer"]
			: options.plan.tools;
		const sessionManager = options.resumeSessionFile
			? SessionManager.open(options.resumeSessionFile)
			: SessionManager.create(
					GUEST_WORKSPACE,
					path.join(options.sessionRoot, options.plan.attemptId),
					options.forkContext
						? { parentSession: options.forkContext.parentSessionFile }
						: undefined,
				);
		if (!options.resumeSessionFile && options.forkContext) {
			for (const message of options.forkContext.messages) {
				sessionManager.appendMessage(message);
			}
		}
		const created = await createAgentSession({
			cwd: GUEST_WORKSPACE,
			agentDir: getAgentDir(),
			modelRuntime: options.modelRuntime,
			model: resolved.model,
			thinkingLevel: options.plan.model.thinking,
			noTools: "builtin",
			tools: activeTools,
			customTools,
			resourceLoader: loader,
			sessionManager,
			settingsManager,
		});
		session = created.session;
		baselineUsage = usage(session);
		baselineMessageIndex = session.messages.length;
		const priorBudgetEvents = await options.journal.readEvents();
		const priorResults = priorBudgetEvents
			.filter(
				(event) =>
					event.type === "attempt-completed" || event.type === "attempt-failed",
			)
			.map((event) => (event.data as { result?: unknown } | undefined)?.result)
			.filter(isRunResult);
		const priorRuntimeMs = priorResults.reduce(
			(total, result) => total + result.runtimeMs,
			0,
		);
		const priorUncachedTokens = priorResults.reduce(
			(total, result) => total + uncachedTokens(result.usage),
			0,
		);
		const runRuntimeLimit = options.plan.limits.runtimeMs + priorRuntimeMs;
		const tokenLimit = options.plan.limits.tokens + priorUncachedTokens;
		let highestBudgetStage = priorBudgetEvents.reduce<BudgetSteeringStage | 0>(
			(highest, event) => {
				if (event.type !== "budget-steering") return highest;
				const data = event.data as
					| { attemptId?: unknown; stage?: unknown }
					| undefined;
				if (data?.attemptId !== options.plan.attemptId) return highest;
				const stage = data.stage;
				return (stage === 0.7 || stage === 0.9) && stage > highest
					? stage
					: highest;
			},
			0,
		);
		let budgetTail = Promise.resolve();
		const budgetTimers: NodeJS.Timeout[] = [];
		const queueBudgetSteering = (
			stage: BudgetSteeringStage,
			trigger: BudgetSteeringTrigger,
			used: number,
			limit: number,
		) => {
			if (stage <= highestBudgetStage || runSignal.aborted) return;
			highestBudgetStage = stage;
			const text = budgetSteeringMessage({ stage, trigger, used, limit });
			budgetTail = budgetTail
				.then(async () => {
					await options.journal.append("budget-steering", {
						attemptId: options.plan.attemptId,
						stage,
						trigger,
						used,
						limit,
						text,
					});
					await session?.steer(text);
				})
				.catch(() => {});
		};
		const scheduleRuntimeStage = (
			stage: BudgetSteeringStage,
			trigger: Extract<
				BudgetSteeringTrigger,
				"run-runtime" | "attempt-runtime"
			>,
			limit: number,
			alreadyUsed: number,
		) => {
			const delay = Math.max(
				0,
				Math.floor(limit * stage) - alreadyUsed - elapsedRuntimeMs(),
			);
			const timer = setTimeout(() => {
				const used =
					trigger === "run-runtime"
						? priorRuntimeMs + elapsedRuntimeMs()
						: elapsedRuntimeMs();
				queueBudgetSteering(stage, trigger, used, limit);
			}, delay);
			timer.unref?.();
			budgetTimers.push(timer);
		};
		for (const stage of [0.7, 0.9] as const) {
			scheduleRuntimeStage(
				stage,
				"run-runtime",
				runRuntimeLimit,
				priorRuntimeMs,
			);
			scheduleRuntimeStage(
				stage,
				"attempt-runtime",
				options.plan.limits.attemptRuntimeMs,
				0,
			);
		}
		const unsubscribeBudget = session.subscribe((event) => {
			if (event.type !== "turn_end") return;
			const current = subtractUsage(
				usage(session as AgentSession),
				baselineUsage,
			);
			budgetTail = budgetTail
				.then(() =>
					options.journal.append("usage-checkpoint", {
						attemptId: options.plan.attemptId,
						usage: current,
						runtimeMs: elapsedRuntimeMs(),
					}),
				)
				.then(() => undefined)
				.catch(() => {});
			const used = priorUncachedTokens + uncachedTokens(current);
			for (const stage of budgetStagesForPressure(used / tokenLimit))
				queueBudgetSteering(stage, "tokens", used, tokenLimit);
		});
		stopBudgetSteering = async () => {
			for (const timer of budgetTimers) clearTimeout(timer);
			unsubscribeBudget();
			await budgetTail;
		};
		options.registerControl?.({
			steer: (text) =>
				session?.steer(text) ??
				Promise.reject(new Error("session unavailable")),
			followUp: (text) =>
				session?.followUp(text) ??
				Promise.reject(new Error("session unavailable")),
		});
		sessionFile = session.sessionFile;
		await options.journal.append("session-started", {
			sessionId: session.sessionId,
			sessionFile: session.sessionFile,
		});
		await session.prompt(
			options.resumeSessionFile
				? "Resume the interrupted task. Revalidate the current workspace state, complete the original goal, and return the required final result."
				: delegatedPrompt(options.plan),
		);
		if (finalAnswer) {
			for (
				let repair = 0;
				repair < 2 && finalAnswer.getValue() === undefined;
				repair++
			) {
				await session.prompt(
					"The task is incomplete. Call final_answer exactly once with a value matching the required schema. Do not return the answer as ordinary text.",
				);
			}
			structuredOutput = finalAnswer.getValue();
			if (structuredOutput === undefined) {
				throw new Error("structured output repair exhausted");
			}
		}
		await session.agent.waitForIdle();
		runSignal.throwIfAborted();
		await stopBudgetSteering();
		collectedUsage = subtractUsage(usage(session), baselineUsage);
		const rawOutput =
			structuredOutput === undefined
				? assistantOutput(session, baselineMessageIndex)
				: canonicalJson(structuredOutput);
		const mediaType =
			structuredOutput === undefined ? "text/plain" : "application/json";
		const artifactOutput = boundAttemptOutput(
			rawOutput,
			options.plan.limits.outputBytes,
		);
		outputRef = await options.artifactStore.put(
			artifactOutput.output,
			mediaType,
		);
		const inlineOutput = boundAttemptOutput(
			artifactOutput.output,
			MAX_INLINE_OUTPUT_BYTES,
		);
		output = inlineOutput.output;
		truncated = artifactOutput.truncated || inlineOutput.truncated;
		if (
			uncachedTokens(collectedUsage) > options.plan.limits.tokens ||
			collectedUsage.cost > options.plan.limits.cost
		) {
			throw new Error("attempt usage limit exceeded");
		}
		session.dispose();
		session = undefined;
		await sandbox.close();
		sandboxCleanup = "proved";

		if (options.plan.workspace.mode === "worktree") {
			if (!options.worktree)
				throw new Error("writing attempt has no worktree record");
			handoff = await finalizeWorktreeHandoff(
				options.worktree,
				`feat(subagent): handoff ${options.plan.attemptId}`,
				options.lease,
			);
			workspaceCleanup = "proved";
		}
		const result = terminalResult({
			plan: options.plan,
			status: "completed",
			usage: collectedUsage,
			usageComplete: true,
			runtimeMs: elapsedRuntimeMs(),
			sandboxCleanup,
			workspaceCleanup,
			truncated,
			...(outputRef ? { output: outputRef } : {}),
			...(structuredOutput !== undefined ? { structuredOutput } : {}),
		});
		await options.journal.append("attempt-completed", {
			result,
			output,
			sessionFile,
			handoff,
		});
		await options.journal.writeSnapshot({
			result,
			output,
			sessionFile,
			handoff,
		});
		return {
			result,
			output,
			sessionFile,
			handoff,
			structuredOutput,
			error: undefined,
		};
	} catch (error) {
		await stopBudgetSteering().catch(() => {});
		if (session) {
			collectedUsage = subtractUsage(usage(session), baselineUsage);
			const bounded = boundAttemptOutput(
				assistantOutput(session, baselineMessageIndex),
				Math.min(options.plan.limits.outputBytes, MAX_INLINE_OUTPUT_BYTES),
			);
			output = bounded.output;
			truncated = bounded.truncated;
			await session.abort().catch(() => {});
			session.dispose();
			session = undefined;
		}
		if (sandbox?.isClosed()) {
			sandboxCleanup = "proved";
		} else if (sandbox) {
			try {
				await sandbox.cancel();
				sandboxCleanup = "proved";
			} catch {
				sandboxCleanup = "blocked";
			}
		}
		const status: RunResult["status"] =
			sandboxCleanup === "blocked"
				? "cleanup-blocked"
				: options.signal?.aborted
					? options.signal.reason === "seat-shutdown"
						? "interrupted"
						: "cancelled"
					: "failed";
		const failure = classifyAttemptFailure({
			error,
			timedOut: timeoutSignal.aborted && !options.signal?.aborted,
			fatalToolAbort,
			...(options.signal?.aborted
				? { externalAbortReason: options.signal.reason }
				: {}),
			sandboxCleanup,
			workspaceCleanup,
		});
		const result = terminalResult({
			plan: options.plan,
			status,
			usage: collectedUsage,
			usageComplete: false,
			runtimeMs: elapsedRuntimeMs(),
			failure,
			sandboxCleanup,
			workspaceCleanup,
			truncated,
		});
		const message = failure.message;
		await options.journal.append("attempt-failed", {
			result,
			output,
			sessionFile,
			handoff,
			error: message,
		});
		await options.journal.writeSnapshot({
			result,
			output,
			sessionFile,
			handoff,
			error: message,
		});
		return {
			result,
			output,
			sessionFile,
			handoff,
			structuredOutput,
			error: message,
		};
	} finally {
		await stopBudgetSteering().catch(() => {});
		options.registerControl?.(undefined);
		runSignal.removeEventListener("abort", abort);
	}
}
