import { stat } from "node:fs/promises";
import path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ExactModelRequest } from "./launch-contracts.js";
import type { DiscoveredAgent } from "./preflight/agents.js";
import { canonicalSha256 } from "./preflight/canonical.js";
import type { SubagentService } from "./service.js";

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

	async function ensureService(
		ctx: ExtensionContext,
	): Promise<SubagentService> {
		if (service) return service;
		servicePromise ??= (async () => {
			const [gondolin, capacityModule, serviceModule] = await Promise.all([
				import("@earendil-works/gondolin"),
				import("./sandbox/capacity.js"),
				import("./service.js"),
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
			if (!manifest) throw new Error("Gondolin image manifest is unavailable.");
			const capacity = await capacityModule.createVmCapacityManager({
				root: path.join(getAgentDir(), "subagents", "capacity"),
				maxSlots: 4,
			});
			const rootfs = await stat(assets.rootfsPath);
			service = await serviceModule.createSubagentService({
				root: path.join(getAgentDir(), "subagents", "service"),
				agents,
				agentDir: getAgentDir(),
				isProjectTrusted: (cwd) => cwd === ctx.cwd && ctx.isProjectTrusted(),
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
			});
			return service;
		})().catch((error) => {
			servicePromise = undefined;
			throw error;
		});
		return servicePromise;
	}

	pi.on("session_shutdown", async () => {
		await service?.shutdown();
		service = undefined;
		servicePromise = undefined;
		modelRuntime = undefined;
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description:
			"Run one native Pi subagent in a dedicated Gondolin VM. Models and credentials stay in the host Pi seat; tool effects are confined to a read-only checkout or private Git worktree.",
		parameters,
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			const runtime = await ensureService(ctx);
			const model = parseModel(params.model, ctx);
			const selectedProvider = ctx.modelRegistry.getProvider(model.provider);
			if (selectedProvider)
				modelRuntime?.registerNativeProvider(selectedProvider);
			const thinking = resolveThinking(params.thinking, ctx);
			const tools = params.tools ?? READ_ONLY_TOOLS;
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
				workspaceMode,
				timeoutMs: params.timeoutMs ?? 600_000,
			});
			const agent = {
				name: `dynamic-${agentIdentity.slice(0, 32)}`,
				source: `<extension-agent:${agentIdentity}>`,
				sha256: agentIdentity,
				defaultModel: { ...model, thinking },
				allowedModels: [`${model.provider}/${model.id}:${thinking}`],
				tools: [...tools],
				preloadSkills: [...(params.preloadSkills ?? [])],
				workspaceModes: [workspaceMode],
				limitCeiling: {
					runtimeMs: params.timeoutMs ?? 600_000,
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
			const client = runtime.forOwner({
				id: `pi-session:${ctx.sessionManager.getSessionId()}`,
				parentSessionId: ctx.sessionManager.getSessionId(),
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
				contextMode: "fresh",
				model: agent.defaultModel,
				tools,
				preloadSkills: [...(params.preloadSkills ?? [])],
				workspace: { mode: workspaceMode, cwd: ctx.cwd },
				limits: agent.limitCeiling,
			});
			const receipt = await client.launch(
				preflight.preflightId,
				preflight.identitySha256,
			);
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
