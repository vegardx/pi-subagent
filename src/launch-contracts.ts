import { type Static, Type } from "typebox";
import {
	AttemptIdSchema,
	CONTRACT_REVISION,
	RunIdSchema,
} from "./contracts.js";

const IdentitySchema = Type.String({ minLength: 1, maxLength: 256 });
const Sha256Schema = Type.String({ pattern: "^[a-f0-9]{64}$" });
const ResourceNameSchema = Type.String({
	pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]*$",
	minLength: 1,
	maxLength: 128,
});

export const DelegatedTaskSchema = Type.Object(
	{
		goal: Type.String({ minLength: 1, maxLength: 16 * 1024 }),
		context: Type.Array(Type.String({ maxLength: 16 * 1024 }), {
			maxItems: 64,
		}),
		instructions: Type.Array(Type.String({ maxLength: 16 * 1024 }), {
			minItems: 1,
			maxItems: 64,
		}),
	},
	{ additionalProperties: false },
);
export type DelegatedTask = Static<typeof DelegatedTaskSchema>;

export const ExactModelRequestSchema = Type.Object(
	{
		provider: ResourceNameSchema,
		id: Type.String({ minLength: 1, maxLength: 256 }),
		thinking: Type.Union([
			Type.Literal("off"),
			Type.Literal("minimal"),
			Type.Literal("low"),
			Type.Literal("medium"),
			Type.Literal("high"),
			Type.Literal("xhigh"),
		]),
	},
	{ additionalProperties: false },
);
export type ExactModelRequest = Static<typeof ExactModelRequestSchema>;

export const WorkspaceRequestSchema = Type.Union([
	Type.Object(
		{
			mode: Type.Literal("read-only"),
			cwd: Type.String({ minLength: 1, maxLength: 4096 }),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			mode: Type.Literal("worktree"),
			cwd: Type.String({ minLength: 1, maxLength: 4096 }),
		},
		{ additionalProperties: false },
	),
]);
export type WorkspaceRequest = Static<typeof WorkspaceRequestSchema>;

export const RunLimitsSchema = Type.Object(
	{
		runtimeMs: Type.Integer({ minimum: 1_000, maximum: 3_600_000 }),
		attemptRuntimeMs: Type.Integer({
			minimum: 1_000,
			maximum: 3_600_000,
		}),
		tokens: Type.Integer({ minimum: 1, maximum: 10_000_000 }),
		cost: Type.Number({ minimum: 0, maximum: 10_000 }),
		outputBytes: Type.Integer({ minimum: 1, maximum: 16 * 1024 * 1024 }),
		workspaceWriteBytes: Type.Integer({
			minimum: 0,
			maximum: 16 * 1024 * 1024 * 1024,
		}),
		retries: Type.Integer({ minimum: 0, maximum: 10 }),
		resumes: Type.Integer({ minimum: 0, maximum: 10 }),
	},
	{ additionalProperties: false },
);
export type RunLimits = Static<typeof RunLimitsSchema>;

export const ContextScopeSchema = Type.Union([
	Type.Literal("global"),
	Type.Literal("project"),
]);
export type ContextScope = Static<typeof ContextScopeSchema>;

export const SubagentRequestSchema = Type.Object(
	{
		operationId: IdentitySchema,
		agent: ResourceNameSchema,
		task: DelegatedTaskSchema,
		contextMode: Type.Union([Type.Literal("fresh"), Type.Literal("fork")]),
		model: Type.Optional(ExactModelRequestSchema),
		tools: Type.Array(ResourceNameSchema, { maxItems: 64, uniqueItems: true }),
		preloadSkills: Type.Array(ResourceNameSchema, {
			maxItems: 64,
			uniqueItems: true,
		}),
		contextScopes: Type.Array(ContextScopeSchema, {
			maxItems: 2,
			uniqueItems: true,
		}),
		workspace: WorkspaceRequestSchema,
		outputSchema: Type.Optional(Type.Unknown()),
		limits: RunLimitsSchema,
	},
	{ additionalProperties: false },
);
export type SubagentRequest = Static<typeof SubagentRequestSchema>;

export const ResourceGrantSchema = Type.Object(
	{
		kind: Type.Union([
			Type.Literal("agent"),
			Type.Literal("tool"),
			Type.Literal("skill"),
			Type.Literal("context"),
		]),
		name: ResourceNameSchema,
		source: Type.String({ minLength: 1, maxLength: 4096 }),
		sha256: Sha256Schema,
	},
	{ additionalProperties: false },
);
export type ResourceGrant = Static<typeof ResourceGrantSchema>;

export const AgentLaunchPlanSchema = Type.Object(
	{
		schema: Type.Literal("pi-subagent-launch"),
		contractRevision: Type.Literal(CONTRACT_REVISION),
		operationId: IdentitySchema,
		ownerId: IdentitySchema,
		runId: RunIdSchema,
		attemptId: AttemptIdSchema,
		agent: ResourceNameSchema,
		agentDisplayName: Type.String({ minLength: 1, maxLength: 128 }),
		agentPrompt: Type.String({ minLength: 1, maxLength: 64 * 1024 }),
		agentSource: Type.String({ minLength: 1, maxLength: 4096 }),
		agentSha256: Sha256Schema,
		agentScope: Type.Union([
			Type.Literal("builtin"),
			Type.Literal("package"),
			Type.Literal("global"),
			Type.Literal("project"),
		]),
		task: DelegatedTaskSchema,
		contextMode: Type.Union([Type.Literal("fresh"), Type.Literal("fork")]),
		forkContext: Type.Optional(
			Type.Object(
				{
					parentSessionId: Type.String({ minLength: 1, maxLength: 128 }),
					parentSessionSha256: Sha256Schema,
					messageIds: Type.Array(
						Type.String({ minLength: 1, maxLength: 128 }),
						{
							maxItems: 100,
						},
					),
					projectionSha256: Sha256Schema,
				},
				{ additionalProperties: false },
			),
		),
		model: ExactModelRequestSchema,
		cwd: Type.Literal("/workspace"),
		tools: Type.Array(ResourceNameSchema, { maxItems: 64, uniqueItems: true }),
		preloadSkills: Type.Array(ResourceNameSchema, {
			maxItems: 64,
			uniqueItems: true,
		}),
		contextScopes: Type.Array(ContextScopeSchema, {
			maxItems: 2,
			uniqueItems: true,
		}),
		resources: Type.Array(ResourceGrantSchema, {
			minItems: 1,
			maxItems: 256,
		}),
		workspace: Type.Object(
			{
				mode: Type.Union([Type.Literal("read-only"), Type.Literal("worktree")]),
				hostPathSha256: Sha256Schema,
				baselineSha256: Sha256Schema,
			},
			{ additionalProperties: false },
		),
		sandbox: Type.Object(
			{
				backend: Type.Literal("gondolin"),
				packageVersion: Type.String({ minLength: 1, maxLength: 64 }),
				imageSha256: Sha256Schema,
				mountPolicySha256: Sha256Schema,
				networkPolicySha256: Sha256Schema,
				capacityPolicySha256: Sha256Schema,
				memoryBytes: Type.Integer({ minimum: 128 * 1024 * 1024 }),
				guestDiskBytes: Type.Integer({ minimum: 1 }),
				workspaceWriteBytes: Type.Integer({ minimum: 0 }),
			},
			{ additionalProperties: false },
		),
		network: Type.Object(
			{
				mode: Type.Literal("public-egress"),
				blockInternalRanges: Type.Literal(true),
			},
			{ additionalProperties: false },
		),
		outputSchema: Type.Optional(Type.Unknown()),
		limits: RunLimitsSchema,
		identitySha256: Sha256Schema,
	},
	{ additionalProperties: false },
);
export type AgentLaunchPlan = Static<typeof AgentLaunchPlanSchema>;
