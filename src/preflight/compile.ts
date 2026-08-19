import { Value } from "typebox/value";
import { type AttemptId, CONTRACT_REVISION, type RunId } from "../contracts.js";
import {
	type AgentLaunchPlan,
	AgentLaunchPlanSchema,
	type ExactModelRequest,
	type ResourceGrant,
	type RunLimits,
	type SubagentRequest,
	SubagentRequestSchema,
} from "../launch-contracts.js";
import { canonicalJson, canonicalSha256 } from "./canonical.js";

export type AgentDefinition = {
	name: string;
	source: string;
	sha256: string;
	defaultModel: ExactModelRequest;
	allowedModels: string[];
	tools: string[];
	preloadSkills: string[];
	workspaceModes: Array<"read-only" | "worktree">;
	limitCeiling: RunLimits;
};

export type ResolvedWorkspace = {
	mode: "read-only" | "worktree";
	hostPathSha256: string;
	baselineSha256: string;
};

export type ResolvedSandbox = {
	packageVersion: string;
	imageSha256: string;
	mountPolicySha256: string;
	networkPolicySha256: string;
	capacityPolicySha256: string;
	memoryBytes: number;
	guestDiskBytes: number;
};

export class PreflightError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PreflightError";
	}
}

function modelKey(model: ExactModelRequest): string {
	return `${model.provider}/${model.id}:${model.thinking}`;
}

function assertSubset(
	kind: string,
	requested: readonly string[],
	allowed: readonly string[],
): void {
	const ceiling = new Set(allowed);
	for (const name of requested) {
		if (!ceiling.has(name))
			throw new PreflightError(`${kind} exceeds ceiling: ${name}`);
	}
}

function assertLimits(requested: RunLimits, ceiling: RunLimits): void {
	for (const key of Object.keys(requested) as Array<keyof RunLimits>) {
		if (requested[key] > ceiling[key]) {
			throw new PreflightError(`limit exceeds ceiling: ${key}`);
		}
	}
}

function validateResources(
	agent: AgentDefinition,
	request: SubagentRequest,
	preloadSkills: string[],
	resources: ResourceGrant[],
): void {
	const byIdentity = new Map<string, ResourceGrant>();
	for (const resource of resources) {
		const key = `${resource.kind}:${resource.name}`;
		if (byIdentity.has(key))
			throw new PreflightError(`duplicate resource: ${key}`);
		byIdentity.set(key, resource);
	}
	const required = [
		`agent:${agent.name}`,
		...request.tools.map((name) => `tool:${name}`),
		...preloadSkills.map((name) => `skill:${name}`),
	];
	const requiredSet = new Set(required);
	for (const key of required) {
		if (!byIdentity.has(key))
			throw new PreflightError(`missing resource: ${key}`);
	}
	for (const [key, resource] of byIdentity) {
		if (resource.kind === "tool" && !requiredSet.has(key)) {
			throw new PreflightError(`unrequested resource: ${key}`);
		}
	}
	const agentGrant = byIdentity.get(`agent:${agent.name}`);
	if (
		agentGrant?.source !== agent.source ||
		agentGrant.sha256 !== agent.sha256
	) {
		throw new PreflightError("agent provenance mismatch");
	}
}

export function verifyLaunchPlanIdentity(plan: AgentLaunchPlan): boolean {
	const { identitySha256, ...draft } = plan;
	return canonicalSha256(draft) === identitySha256;
}

export async function compileLaunchPlan(input: {
	ownerId: string;
	runId: RunId;
	attemptId: AttemptId;
	request: SubagentRequest;
	agent: AgentDefinition;
	resources: ResourceGrant[];
	workspace: ResolvedWorkspace;
	sandbox: ResolvedSandbox;
	resolveModel(model: ExactModelRequest): Promise<ExactModelRequest>;
}): Promise<AgentLaunchPlan> {
	if (!Value.Check(SubagentRequestSchema, input.request)) {
		const details = [...Value.Errors(SubagentRequestSchema, input.request)]
			.map((error) => `${error.instancePath || "/"}: ${error.message}`)
			.join("; ");
		throw new PreflightError(
			`request violates schema${details ? `: ${details}` : ""}`,
		);
	}
	if (input.request.agent !== input.agent.name) {
		throw new PreflightError("agent resolution mismatch");
	}
	assertSubset("tool", input.request.tools, input.agent.tools);
	const preloadSkills = [
		...new Set([...input.agent.preloadSkills, ...input.request.preloadSkills]),
	].sort();
	if (!input.agent.workspaceModes.includes(input.request.workspace.mode)) {
		throw new PreflightError("workspace mode exceeds ceiling");
	}
	if (input.workspace.mode !== input.request.workspace.mode) {
		throw new PreflightError("workspace resolution mismatch");
	}
	assertLimits(input.request.limits, input.agent.limitCeiling);
	validateResources(input.agent, input.request, preloadSkills, input.resources);

	const requestedModel = input.request.model ?? input.agent.defaultModel;
	if (!input.agent.allowedModels.includes(modelKey(requestedModel))) {
		throw new PreflightError(
			`model exceeds ceiling: ${modelKey(requestedModel)}`,
		);
	}
	const model = await input.resolveModel(requestedModel);
	if (
		model.provider !== requestedModel.provider ||
		model.id !== requestedModel.id ||
		model.thinking !== requestedModel.thinking
	) {
		throw new PreflightError("model resolver changed exact selection");
	}

	const draft = {
		schema: "pi-subagent-launch" as const,
		contractRevision: CONTRACT_REVISION,
		operationId: input.request.operationId,
		ownerId: input.ownerId,
		runId: input.runId,
		attemptId: input.attemptId,
		agent: input.agent.name,
		task: input.request.task,
		contextMode: input.request.contextMode,
		model,
		cwd: "/workspace" as const,
		tools: [...input.request.tools].sort(),
		preloadSkills,
		resources: input.resources
			.map((resource) => ({ ...resource }))
			.sort((left, right) => {
				const leftKey = `${left.kind}:${left.name}:${left.source}`;
				const rightKey = `${right.kind}:${right.name}:${right.source}`;
				return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
			}),
		workspace: {
			mode: input.workspace.mode,
			hostPathSha256: input.workspace.hostPathSha256,
			baselineSha256: input.workspace.baselineSha256,
		},
		sandbox: {
			backend: "gondolin" as const,
			...input.sandbox,
			workspaceWriteBytes: input.request.limits.workspaceWriteBytes,
		},
		network: {
			mode: "public-egress" as const,
			blockInternalRanges: true as const,
		},
		...(input.request.outputSchema === undefined
			? {}
			: { outputSchema: input.request.outputSchema }),
		limits: { ...input.request.limits },
	};
	const plan: AgentLaunchPlan = {
		...draft,
		identitySha256: canonicalSha256(draft),
	};
	if (Buffer.byteLength(canonicalJson(plan), "utf8") > 768 * 1024) {
		throw new PreflightError("compiled launch plan exceeds byte limit");
	}
	if (!Value.Check(AgentLaunchPlanSchema, plan)) {
		const details = [...Value.Errors(AgentLaunchPlanSchema, plan)]
			.map((error) => `${error.instancePath || "/"}: ${error.message}`)
			.join("; ");
		throw new PreflightError(
			`compiled launch plan violates schema${details ? `: ${details}` : ""}`,
		);
	}
	return plan;
}
