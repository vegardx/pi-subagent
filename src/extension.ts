import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runSubagent } from "./service.js";

const DEFAULT_TOOLS = ["read", "grep", "find", "ls"];

const parameters = Type.Object({
	agent: Type.String({
		description: "Short name for this delegated agent.",
		minLength: 1,
	}),
	task: Type.String({ description: "Self-contained task for the agent." }),
	model: Type.Optional(
		Type.String({ description: "Exact provider/model override." }),
	),
	thinking: Type.Optional(
		StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"]),
	),
	tools: Type.Optional(
		Type.Array(Type.String(), {
			description: "Built-in tool allowlist. Defaults to read-only tools.",
		}),
	),
	cwd: Type.Optional(
		Type.String({
			description: "Child working directory. Defaults to the seat cwd.",
		}),
	),
	timeoutMs: Type.Optional(
		Type.Integer({
			description: "Run timeout in milliseconds.",
			minimum: 1_000,
			maximum: 3_600_000,
		}),
	),
});

export default function subagentExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description:
			"Run one experimental native Pi subagent through an isolated RPC child. This first slice supports fresh foreground runs and explicit built-in tools; durable control, retry, resume, worktrees, and sandboxing are not implemented yet.",
		parameters,
		async execute(_id, params, signal, _onUpdate, ctx) {
			const result = await runSubagent(
				{
					agent: params.agent,
					task: params.task,
					cwd: params.cwd ?? ctx.cwd,
					model:
						params.model ??
						(ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined),
					thinking: params.thinking ?? ctx.thinkingLevel,
					tools: params.tools ?? DEFAULT_TOOLS,
					timeoutMs: params.timeoutMs ?? 600_000,
				},
				signal,
			);
			return {
				content: [{ type: "text", text: result.output }],
				details: result,
				usage: {
					input: result.usage.input,
					output: result.usage.output,
					cacheRead: result.usage.cacheRead,
					cacheWrite: result.usage.cacheWrite,
					totalTokens: result.usage.totalTokens,
					cost: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						total: result.usage.cost,
					},
				},
			};
		},
	});
}
