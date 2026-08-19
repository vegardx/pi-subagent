import { randomUUID } from "node:crypto";
import { realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { ExactModelRequest } from "./launch-contracts.js";
import type { DiscoveredAgent } from "./preflight/agents.js";
import { canonicalSha256 } from "./preflight/canonical.js";
import type { RunSummary, SubagentService } from "./service.js";
import {
	attentionWidgetLines,
	type InspectorAction,
	type InspectorState,
	showRetentionReport,
	showSubagentInspector,
} from "./ui/inspector.js";

const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];
const THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
] as const;
const MUTATING_TOOLS = new Set(["write", "edit", "bash"]);

const parameters = Type.Object({
	agent: Type.String({ minLength: 1, maxLength: 128 }),
	task: Type.String({ minLength: 1, maxLength: 16 * 1024 }),
	contextMode: Type.Optional(StringEnum(["fresh", "fork"] as const)),
	model: Type.Optional(Type.String({ minLength: 3, maxLength: 512 })),
	thinking: Type.Optional(StringEnum(THINKING_LEVELS)),
	tools: Type.Optional(
		Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
			maxItems: 16,
			uniqueItems: true,
		}),
	),
	preloadSkills: Type.Optional(
		Type.Array(Type.String({ minLength: 1, maxLength: 64 }), {
			maxItems: 16,
			uniqueItems: true,
		}),
	),
	contextScopes: Type.Optional(
		Type.Array(StringEnum(["global", "project"] as const), {
			maxItems: 2,
			uniqueItems: true,
		}),
	),
	timeoutMs: Type.Optional(
		Type.Integer({ minimum: 1_000, maximum: 3_600_000 }),
	),
});

function resolveThinking(
	value: string | undefined,
	ctx: ExtensionContext,
): ExactModelRequest["thinking"] {
	const candidate = value ?? ctx.thinkingLevel ?? "medium";
	if (candidate === "max") {
		throw new Error("The subagent contract does not support max thinking.");
	}
	if (
		!THINKING_LEVELS.includes(candidate as (typeof THINKING_LEVELS)[number])
	) {
		throw new Error(`Unsupported thinking level: ${candidate}`);
	}
	return candidate as ExactModelRequest["thinking"];
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	if (bytes < 1024 * 1024 * 1024) {
		return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
	}
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

function parseModel(
	value: string | undefined,
	ctx: ExtensionContext,
): { provider: string; id: string } {
	if (!value) {
		if (!ctx.model) throw new Error("No active model is available.");
		return { provider: ctx.model.provider, id: ctx.model.id };
	}
	const separator = value.indexOf("/");
	if (separator < 1 || separator === value.length - 1) {
		throw new Error("Model must use provider/model syntax.");
	}
	return {
		provider: value.slice(0, separator),
		id: value.slice(separator + 1),
	};
}

export default function piSubagentExtension(pi: ExtensionAPI): void {
	const agents = new Map<string, DiscoveredAgent>();
	let modelRuntime: ModelRuntime | undefined;
	let service: SubagentService | undefined;
	let servicePromise: Promise<SubagentService> | undefined;
	let widgetUnsubscribe: (() => void) | undefined;

	async function ensureService(
		ctx: ExtensionContext,
	): Promise<SubagentService> {
		if (service) return service;
		servicePromise ??= (async () => {
			const serviceModule = await import("./service.js");
			service = await serviceModule.createSubagentService({
				root: path.join(getAgentDir(), "subagents", "service"),
				agents,
				agentDir: getAgentDir(),
				isProjectTrusted: (cwd) => cwd === ctx.cwd && ctx.isProjectTrusted(),
				async loadExecution() {
					const [gondolin, capacityModule] = await Promise.all([
						import("@earendil-works/gondolin"),
						import("./sandbox/capacity.js"),
					]);
					modelRuntime = await ModelRuntime.create();
					for (const providerId of ctx.modelRegistry.getRegisteredProviderIds()) {
						const provider =
							ctx.modelRegistry.getRegisteredNativeProvider(providerId) ??
							ctx.modelRegistry.getProvider(providerId);
						if (provider) modelRuntime.registerNativeProvider(provider);
					}
					if (ctx.model) {
						const provider = ctx.modelRegistry.getProvider(ctx.model.provider);
						if (provider) modelRuntime.registerNativeProvider(provider);
					}
					const assets = await gondolin.ensureGuestAssets();
					const manifest = gondolin.loadAssetManifest(
						path.dirname(assets.kernelPath),
					);
					if (!manifest) {
						throw new Error("Gondolin image manifest is unavailable.");
					}
					const capacity = await capacityModule.createVmCapacityManager({
						root: path.join(getAgentDir(), "subagents", "capacity"),
						maxSlots: 4,
					});
					const rootfs = await stat(assets.rootfsPath);
					return {
						modelRuntime,
						capacity,
						sandbox: {
							packageVersion: "0.12.0",
							imageSha256: canonicalSha256(manifest.checksums),
							mountPolicySha256: canonicalSha256({
								backend: "gondolin-vfs",
								version: 1,
							}),
							networkPolicySha256: canonicalSha256({
								mode: "public-egress",
								blockInternalRanges: true,
								allowWebSockets: false,
							}),
							capacityPolicySha256: canonicalSha256({
								basePort: capacity.basePort,
								maxSlots: capacity.maxSlots,
							}),
							memoryBytes: 512 * 1024 * 1024,
							guestDiskBytes: rootfs.size,
						},
					};
				},
			});
			return service;
		})().catch((error) => {
			servicePromise = undefined;
			throw error;
		});
		return servicePromise;
	}

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		try {
			const runtime = await ensureService(ctx);
			const repositoryRoot = await currentRepositoryRoot(ctx);
			const refresh = async () => {
				const page = await runtime.listRuns({
					...(repositoryRoot ? { repositoryRoot } : {}),
					statuses: ["active", "stopping", "interrupted", "cleanup-blocked"],
					limit: 100,
				});
				ctx.ui.setWidget("pi-subagent", attentionWidgetLines(page.runs), {
					placement: "belowEditor",
				});
			};
			await refresh();
			widgetUnsubscribe = runtime.subscribe(() => void refresh());
		} catch {
			ctx.ui.setWidget("pi-subagent", undefined);
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		widgetUnsubscribe?.();
		widgetUnsubscribe = undefined;
		ctx.ui.setWidget("pi-subagent", undefined);
		await service?.shutdown();
		service = undefined;
		servicePromise = undefined;
		modelRuntime = undefined;
	});

	function operatorOutput(
		ctx: ExtensionContext,
		message: string,
		level: "info" | "warning" | "error" = "info",
	): void {
		if (ctx.mode === "print") console.log(message);
		else ctx.ui.notify(message, level);
	}

	async function currentRepositoryRoot(
		ctx: ExtensionContext,
	): Promise<string | undefined> {
		const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], {
			cwd: ctx.cwd,
			timeout: 5000,
		});
		if (result.code !== 0) return undefined;
		return realpath(result.stdout.trim());
	}

	async function resolveRun(
		runtime: SubagentService,
		prefix: string,
		repositoryRoot?: string,
	): Promise<RunSummary> {
		const matches: RunSummary[] = [];
		let cursor: string | undefined;
		do {
			const page = await runtime.listRuns({
				...(repositoryRoot ? { repositoryRoot } : {}),
				limit: 100,
				...(cursor ? { cursor } : {}),
			});
			matches.push(...page.runs.filter((run) => run.runId.startsWith(prefix)));
			cursor = page.nextCursor;
		} while (cursor && matches.length < 2);
		if (matches.length === 0) throw new Error(`Run not found: ${prefix}`);
		if (matches.length > 1)
			throw new Error(`Run prefix is ambiguous: ${prefix}`);
		const match = matches[0];
		if (!match) throw new Error(`Run not found: ${prefix}`);
		return match;
	}

	function ownerClient(
		runtime: SubagentService,
		run: RunSummary,
		ctx: ExtensionContext,
	) {
		const parentSessionFile = ctx.sessionManager.getSessionFile();
		return runtime.forOwner({
			id: run.ownerId,
			...(run.ownerId === `pi-session:${ctx.sessionManager.getSessionId()}`
				? {
						parentSessionId: ctx.sessionManager.getSessionId(),
						...(parentSessionFile ? { parentSessionFile } : {}),
					}
				: {}),
		});
	}

	async function performAction(
		action: InspectorAction,
		run: RunSummary,
		ctx: ExtensionContext,
		runtime: SubagentService,
		providedText?: string,
		confirmed = false,
	): Promise<void> {
		const client = ownerClient(runtime, run, ctx);
		if (!confirmed && ["stop", "retry", "resume", "release"].includes(action)) {
			const descriptions: Record<string, string> = {
				stop: "The active model session will stop and its VM will close.",
				retry: "A new attempt and fresh VM will consume remaining budgets.",
				resume: "The retained Pi session will continue in a fresh VM.",
				release:
					"The verified worktree and reservation branch will be removed.",
			};
			if (
				ctx.hasUI &&
				!(await ctx.ui.confirm(
					`${action} ${run.agentDisplayName}?`,
					descriptions[action] ?? "Continue?",
				))
			) {
				return;
			}
		}
		if (action === "steer" || action === "follow-up") {
			const text =
				providedText ??
				(action === "steer"
					? await ctx.ui.input("Steer active run", "Instruction")
					: await ctx.ui.editor("Queue follow-up", ""));
			if (!text?.trim()) return;
			const input = { operationId: randomUUID(), text: text.trim() };
			const receipt =
				action === "steer"
					? await client.steer(run.runId, input)
					: await client.followUp(run.runId, input);
			ctx.ui.notify(`${action}: ${receipt.state}`, "info");
			return;
		}
		if (action === "export-output") {
			const inspection = await runtime.inspectRun(run.runId);
			const ref = inspection.result?.result.output;
			if (!ref) throw new Error("run has no output artifact");
			const destination = await ctx.ui.input(
				"Export output artifact",
				path.join(ctx.cwd, `${run.agentDisplayName}-output.txt`),
			);
			if (!destination?.trim()) return;
			const target = path.resolve(ctx.cwd, destination.trim());
			if (
				ctx.hasUI &&
				!(await ctx.ui.confirm(
					"Export artifact?",
					`${ref.bytes} bytes (${ref.mediaType}) will be written to ${target}. Existing content will be replaced.`,
				))
			) {
				return;
			}
			const artifact = await client.exportArtifact(run.runId, ref);
			await writeFile(target, artifact.content, { flag: "w" });
			ctx.ui.notify(`Exported ${target}.`, "info");
			return;
		}
		if (action === "stop") await client.interrupt(run.runId);
		else if (action === "retry") await client.retry(run.runId);
		else if (action === "resume") await client.resume(run.runId);
		else if (action === "reconcile") await client.reconcile(run.runId);
		else if (action === "release") await client.release(run.runId);
		else if (action === "pin") {
			const reason =
				providedText ?? (await ctx.ui.input("Pin run", "Reason (optional)"));
			if (reason === undefined) return;
			await client.pin(run.runId, reason.trim() || "operator pin");
		} else if (action === "unpin") {
			await client.unpin(run.runId);
		}
		ctx.ui.notify(`${action} accepted for ${run.runId}.`, "info");
	}

	async function retention(
		ctx: ExtensionContext,
		runtime: SubagentService,
		apply = false,
	): Promise<void> {
		const preview = await runtime.prune({ dryRun: true });
		const summary = `${preview.selected.length} run(s), ${formatBytes(preview.selected.reduce((total, run) => total + run.bytes, 0))}; ${preview.protected.length} protected.`;
		if (!apply) {
			if (ctx.mode !== "tui") {
				operatorOutput(
					ctx,
					`Retention dry run: ${summary}`,
					preview.selected.length ? "warning" : "info",
				);
				return;
			}
			apply = (await showRetentionReport({ ctx, report: preview })) === "apply";
			if (!apply) return;
		}
		if (
			ctx.hasUI &&
			!(await ctx.ui.confirm(
				"Apply subagent retention?",
				`${summary} Selected state moves to recoverable trash.`,
			))
		) {
			return;
		}
		const report = await runtime.prune({ dryRun: false });
		operatorOutput(
			ctx,
			`Pruned ${report.pruned.length} run(s), ${formatBytes(report.pruned.reduce((total, run) => total + run.bytes, 0))}.`,
		);
	}

	async function inspector(
		ctx: ExtensionContext,
		initialState?: Partial<InspectorState>,
	): Promise<void> {
		const runtime = await ensureService(ctx);
		const repositoryRoot = await currentRepositoryRoot(ctx);
		if (ctx.mode !== "tui") {
			if (initialState?.view === "detail" && initialState.selectedRunId) {
				const detail = await runtime.inspectRun(initialState.selectedRunId);
				operatorOutput(
					ctx,
					[
						`${detail.summary.status.padEnd(15)} ${detail.summary.runId}`,
						`agent: ${detail.summary.agentDisplayName}`,
						`goal: ${detail.summary.goalPreview}`,
						`model: ${detail.plan.model.provider}/${detail.plan.model.id}:${detail.plan.model.thinking}`,
						`workspace: ${detail.summary.workspaceMode}${detail.summary.retainedWorktree ? " retained" : ""}`,
						`attempts: ${detail.attempts.length}`,
					].join("\n"),
				);
				return;
			}
			const page = await runtime.listRuns({
				...(repositoryRoot ? { repositoryRoot } : {}),
				limit: 20,
			});
			operatorOutput(
				ctx,
				page.runs.length
					? page.runs
							.map(
								(run) =>
									`${run.status.padEnd(15)} ${run.runId} ${run.agentDisplayName}`,
							)
							.join("\n")
					: "No subagent runs.",
			);
			return;
		}
		let state: Partial<InspectorState> = initialState ?? {};
		for (;;) {
			const intent = await showSubagentInspector({
				ctx,
				service: runtime,
				...(repositoryRoot ? { repositoryRoot } : {}),
				initialState: state,
			});
			state = intent.state;
			if (intent.type === "close") return;
			if (intent.type === "search") {
				const search = await ctx.ui.input(
					"Search subagent runs",
					intent.state.search ?? "",
				);
				if (search !== undefined) state = { ...state, view: "runs", search };
				continue;
			}
			if (intent.type === "filter") {
				const filter = await ctx.ui.select("Filter subagent runs", [
					"All",
					"Needs attention",
					"Active",
					"Interrupted",
					"Cleanup blocked",
					"Failed",
					"Completed",
				]);
				const filters: Record<string, RunSummary["status"][] | undefined> = {
					All: undefined,
					"Needs attention": [
						"active",
						"stopping",
						"interrupted",
						"cleanup-blocked",
					],
					Active: ["active", "stopping"],
					Interrupted: ["interrupted"],
					"Cleanup blocked": ["cleanup-blocked"],
					Failed: ["failed"],
					Completed: ["completed"],
				};
				if (filter) {
					const statuses = filters[filter];
					state = {
						...state,
						view: "runs",
						...(statuses ? { statuses } : {}),
					};
					if (!statuses) delete state.statuses;
				}
				continue;
			}
			if (intent.type === "retention") {
				await retention(ctx, runtime);
				continue;
			}
			try {
				await performAction(
					intent.action,
					intent.run,
					ctx,
					runtime,
					intent.text,
					intent.confirmed ?? false,
				);
			} catch (error) {
				ctx.ui.notify(
					error instanceof Error ? error.message : String(error),
					"error",
				);
			}
		}
	}

	pi.registerCommand("subagents", {
		description: "Inspect and control isolated subagent runs",
		getArgumentCompletions(prefix) {
			const commands = [
				"list",
				"show",
				"status",
				"logs",
				"wait",
				"steer",
				"follow-up",
				"stop",
				"retry",
				"resume",
				"reconcile",
				"release",
				"pin",
				"unpin",
				"prune",
			];
			if (prefix.includes(" ")) return null;
			const matches = commands
				.filter((command) => command.startsWith(prefix))
				.map((command) => ({ value: command, label: command }));
			return matches.length ? matches : null;
		},
		async handler(args, ctx) {
			const [subcommand, runPrefix, ...rest] = args
				.trim()
				.split(/\s+/)
				.filter(Boolean);
			if (!subcommand) {
				await inspector(ctx);
				return;
			}
			const runtime = await ensureService(ctx);
			const repositoryRoot = await currentRepositoryRoot(ctx);
			if (subcommand === "list") {
				if (runPrefix && runPrefix !== "--all") {
					throw new Error("Usage: /subagents list [--all]");
				}
				await inspector(ctx, {
					allProjects: runPrefix === "--all",
					view: "runs",
				});
				return;
			}
			if (subcommand === "prune") {
				if (runPrefix && runPrefix !== "--apply") {
					throw new Error("Usage: /subagents prune [--apply]");
				}
				await retention(ctx, runtime, runPrefix === "--apply");
				return;
			}
			if (!runPrefix) throw new Error(`Run prefix required for ${subcommand}.`);
			const run = await resolveRun(runtime, runPrefix, repositoryRoot);
			if (subcommand === "show" || subcommand === "status") {
				if (rest.length)
					throw new Error(`Unexpected arguments for ${subcommand}.`);
				await inspector(ctx, { view: "detail", selectedRunId: run.runId });
				return;
			}
			if (subcommand === "logs") {
				if (rest.length) throw new Error("Unexpected arguments for logs.");
				const page = await runtime.runLogs(run.runId, { tail: 20 });
				operatorOutput(
					ctx,
					page.events
						.map(
							(event) =>
								`${event.sequence.toString().padStart(4)} ${event.timestamp} ${event.type}`,
						)
						.join("\n") || "No lifecycle events.",
				);
				return;
			}
			if (subcommand === "wait") {
				if (rest.length) throw new Error("Unexpected arguments for wait.");
				const result = await ownerClient(runtime, run, ctx).wait(run.runId);
				operatorOutput(ctx, `${run.runId}: ${result.result.status}`);
				return;
			}
			const actions: Record<string, InspectorAction> = {
				steer: "steer",
				"follow-up": "follow-up",
				stop: "stop",
				retry: "retry",
				resume: "resume",
				reconcile: "reconcile",
				release: "release",
				pin: "pin",
				unpin: "unpin",
			};
			const action = actions[subcommand];
			if (!action) throw new Error(`Unknown subagents command: ${subcommand}`);
			if (rest.length > 0 && !["steer", "follow-up", "pin"].includes(action)) {
				throw new Error(`Unexpected arguments for ${subcommand}.`);
			}
			await performAction(
				action,
				run,
				ctx,
				runtime,
				["steer", "follow-up", "pin"].includes(action)
					? rest.join(" ") || undefined
					: undefined,
			);
		},
	});

	pi.registerShortcut("alt+s", {
		description:
			"Open the subagent inspector without interrupting active input",
		handler: inspector,
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description:
			"Run one native Pi subagent in a dedicated Gondolin VM. Models and credentials stay in the host Pi seat; tool effects are confined to a read-only checkout or private Git worktree.",
		parameters,
		renderCall(args, theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("muted", args.agent)}`,
				0,
				0,
			);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			const text = result.content.find((item) => item.type === "text");
			const content = text?.type === "text" ? text.text : "";
			return new Text(
				theme.fg(
					isPartial ? "warning" : "success",
					expanded
						? content
						: content.split("\n")[0] || (isPartial ? "active" : "completed"),
				),
				0,
				0,
			);
		},
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const runtime = await ensureService(ctx);
			const model = parseModel(params.model, ctx);
			const selectedProvider = ctx.modelRegistry.getProvider(model.provider);
			if (selectedProvider)
				modelRuntime?.registerNativeProvider(selectedProvider);
			const thinking = resolveThinking(params.thinking, ctx);
			const tools = params.tools ?? READ_ONLY_TOOLS;
			const attemptRuntimeMs = params.timeoutMs ?? 600_000;
			const runRuntimeMs = Math.min(3_600_000, attemptRuntimeMs * 3);
			const workspaceMode: "read-only" | "worktree" = tools.some((tool) =>
				MUTATING_TOOLS.has(tool),
			)
				? "worktree"
				: "read-only";
			const prompt = `You are the delegated Pi agent named ${params.agent}. Complete the bounded task using only the granted tools. Return a concise final answer.`;
			const agentIdentity = canonicalSha256({
				label: params.agent,
				prompt,
				model,
				thinking,
				tools,
				preloadSkills: params.preloadSkills ?? [],
				contextScopes: params.contextScopes ?? [],
				workspaceMode,
				timeoutMs: params.timeoutMs ?? 600_000,
			});
			const agent = {
				name: `dynamic-${agentIdentity.slice(0, 32)}`,
				displayName: params.agent,
				source: `<extension-agent:${agentIdentity}>`,
				sha256: agentIdentity,
				defaultModel: { ...model, thinking },
				allowedModels: [`${model.provider}/${model.id}:${thinking}`],
				tools: [...tools],
				preloadSkills: [...(params.preloadSkills ?? [])],
				contextScopes: [...(params.contextScopes ?? [])],
				workspaceModes: [workspaceMode],
				limitCeiling: {
					runtimeMs: runRuntimeMs,
					attemptRuntimeMs,
					tokens: 1_000_000,
					cost: 100,
					outputBytes: 1024 * 1024,
					workspaceWriteBytes: 512 * 1024 * 1024,
					retries: 1,
					resumes: 1,
				},
				prompt,
				scope: "builtin" as const,
			};
			agents.set(agent.name, agent);
			const parentSessionFile = ctx.sessionManager.getSessionFile();
			const client = runtime.forOwner({
				id: `pi-session:${ctx.sessionManager.getSessionId()}`,
				parentSessionId: ctx.sessionManager.getSessionId(),
				...(parentSessionFile ? { parentSessionFile } : {}),
			});
			const preflight = await client.preflight({
				operationId: `tool-${canonicalSha256({
					parentSessionId: ctx.sessionManager.getSessionId(),
					toolCallId,
				})}`,
				agent: agent.name,
				task: {
					goal: params.task,
					context: [],
					instructions: ["Complete the goal and report the result."],
				},
				contextMode: params.contextMode ?? "fresh",
				model: agent.defaultModel,
				tools,
				preloadSkills: [...(params.preloadSkills ?? [])],
				contextScopes: [...(params.contextScopes ?? [])],
				workspace: { mode: workspaceMode, cwd: ctx.cwd },
				limits: agent.limitCeiling,
			});
			const receipt = await client.launch(
				preflight.preflightId,
				preflight.identitySha256,
			);
			onUpdate?.({
				content: [
					{
						type: "text",
						text: `Subagent ${params.agent} is active (${receipt.runId}).`,
					},
				],
				details: {
					runId: receipt.runId,
					attemptId: receipt.attemptId,
					status: receipt.status,
				},
			});
			const onAbort = () => void client.interrupt(receipt.runId);
			signal?.addEventListener("abort", onAbort, { once: true });
			try {
				const execution = await client.wait(receipt.runId);
				if (execution.result.status !== "completed") {
					throw new Error(
						execution.error ?? `Subagent ended as ${execution.result.status}.`,
					);
				}
				return {
					content: [{ type: "text", text: execution.output }],
					details: {
						runId: receipt.runId,
						attemptId: receipt.attemptId,
						result: execution.result,
						handoff: execution.handoff,
					},
					usage: {
						input: execution.result.usage.input,
						output: execution.result.usage.output,
						cacheRead: execution.result.usage.cacheRead,
						cacheWrite: execution.result.usage.cacheWrite,
						totalTokens: execution.result.usage.totalTokens,
						cost: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							total: execution.result.usage.cost,
						},
					},
				};
			} finally {
				signal?.removeEventListener("abort", onAbort);
			}
		},
	});
}
