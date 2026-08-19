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
import { canonicalJson } from "../preflight/canonical.js";
import { verifyLaunchPlanIdentity } from "../preflight/compile.js";
import { resolveExactPiModel } from "../preflight/models.js";
import type { VmCapacityManager } from "../sandbox/capacity.js";
import {
	createGondolinAttemptSandbox,
	type GondolinAttemptSandbox,
} from "../sandbox/gondolin.js";
import { GUEST_WORKSPACE } from "../sandbox/tools.js";
import {
	captureWorktreeHandoff,
	removeCleanWorktree,
	type WorktreeRecord,
} from "../workspace/worktree.js";
import { createFinalAnswerController } from "./structured-output.js";

const MAX_INLINE_OUTPUT_BYTES = 32 * 1024;

export type AttemptExecutionResult = {
	result: RunResult;
	output: string;
	sessionFile: string | undefined;
	handoff: WorktreeRecord | undefined;
	structuredOutput: unknown | undefined;
	error: string | undefined;
};

function assistantOutput(session: AgentSession): string {
	for (let index = session.messages.length - 1; index >= 0; index--) {
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
	worktree?: WorktreeRecord;
	modelRuntime: ModelRuntime;
	capacity: VmCapacityManager;
	lease: RunLease;
	journal: RunJournal;
	artifactStore: ArtifactStore;
	sessionRoot: string;
	resumeSessionFile?: string;
	signal?: AbortSignal;
}): Promise<AttemptExecutionResult> {
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
	if (options.plan.contextMode !== "fresh") {
		throw new Error("fork context is not implemented");
	}
	if (options.plan.skills.length > 0) {
		throw new Error("explicit skills are not implemented");
	}
	if (options.plan.resources.some((resource) => resource.kind === "context")) {
		throw new Error("explicit context resources are not implemented");
	}
	const finalAnswer =
		options.plan.outputSchema === undefined
			? undefined
			: createFinalAnswerController(options.plan.outputSchema);
	if (
		options.agent.name !== options.plan.agent ||
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
	let output = "";
	let outputRef: ArtifactRef | undefined;
	let structuredOutput: unknown | undefined;
	let truncated = false;
	const timeoutSignal = AbortSignal.timeout(options.plan.limits.runtimeMs);
	const runSignal = options.signal
		? AbortSignal.any([options.signal, timeoutSignal])
		: timeoutSignal;
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
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPrompt: `${options.agent.prompt}\n\nCurrent working directory: ${GUEST_WORKSPACE} (Gondolin VM).`,
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
				);
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
		collectedUsage = usage(session);
		const rawOutput =
			structuredOutput === undefined
				? assistantOutput(session)
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
			collectedUsage.totalTokens > options.plan.limits.tokens ||
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
			handoff = await captureWorktreeHandoff(
				options.worktree,
				`feat(subagent): handoff ${options.plan.attemptId}`,
				options.lease,
			);
			await removeCleanWorktree(handoff, options.lease);
			workspaceCleanup = "proved";
		}
		const result = terminalResult({
			plan: options.plan,
			status: "completed",
			usage: collectedUsage,
			usageComplete: true,
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
		if (session) {
			collectedUsage = usage(session);
			const bounded = boundAttemptOutput(
				assistantOutput(session),
				Math.min(options.plan.limits.outputBytes, MAX_INLINE_OUTPUT_BYTES),
			);
			output = bounded.output;
			truncated = bounded.truncated;
			await session.abort().catch(() => {});
			session.dispose();
			session = undefined;
		}
		if (sandbox && !sandbox.isClosed()) {
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
					? "cancelled"
					: "failed";
		const result = terminalResult({
			plan: options.plan,
			status,
			usage: collectedUsage,
			usageComplete: false,
			sandboxCleanup,
			workspaceCleanup,
			truncated,
		});
		const message = error instanceof Error ? error.message : String(error);
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
		runSignal.removeEventListener("abort", abort);
	}
}
