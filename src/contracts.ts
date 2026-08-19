import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

export const CONTRACT_REVISION = 1 as const;

export const RunIdSchema = Type.String({
	pattern: "^run_[a-z0-9]+$",
	minLength: 5,
	maxLength: 128,
});
export type RunId = Static<typeof RunIdSchema>;

export const AttemptIdSchema = Type.String({
	pattern: "^attempt_[a-z0-9]+$",
	minLength: 9,
	maxLength: 128,
});
export type AttemptId = Static<typeof AttemptIdSchema>;

export const RunStatusSchema = Type.Union([
	Type.Literal("queued"),
	Type.Literal("active"),
	Type.Literal("stopping"),
	Type.Literal("completed"),
	Type.Literal("failed"),
	Type.Literal("cancelled"),
	Type.Literal("interrupted"),
	Type.Literal("cleanup-blocked"),
]);
export type RunStatus = Static<typeof RunStatusSchema>;

export const AttemptStatusSchema = Type.Union([
	Type.Literal("preparing"),
	Type.Literal("running"),
	Type.Literal("settling"),
	Type.Literal("completed"),
	Type.Literal("failed"),
	Type.Literal("cancelled"),
	Type.Literal("interrupted"),
]);
export type AttemptStatus = Static<typeof AttemptStatusSchema>;

export const CleanupOutcomeSchema = Type.Union([
	Type.Literal("proved"),
	Type.Literal("not-needed"),
	Type.Literal("retained"),
	Type.Literal("blocked"),
	Type.Literal("unknown"),
]);
export type CleanupOutcome = Static<typeof CleanupOutcomeSchema>;

export const UsageSchema = Type.Object(
	{
		input: Type.Integer({ minimum: 0 }),
		output: Type.Integer({ minimum: 0 }),
		cacheRead: Type.Integer({ minimum: 0 }),
		cacheWrite: Type.Integer({ minimum: 0 }),
		totalTokens: Type.Integer({ minimum: 0 }),
		cost: Type.Number({ minimum: 0 }),
	},
	{ additionalProperties: false },
);
export type Usage = Static<typeof UsageSchema>;

export const ArtifactRefSchema = Type.Object(
	{
		id: Type.String({ pattern: "^artifact_[a-f0-9]{64}$" }),
		sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
		bytes: Type.Integer({ minimum: 0 }),
		mediaType: Type.String({
			pattern:
				"^[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]*/[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]*$",
			maxLength: 256,
		}),
	},
	{ additionalProperties: false },
);
export type ArtifactRef = Static<typeof ArtifactRefSchema>;

export const RunResultSchema = Type.Object(
	{
		runId: RunIdSchema,
		status: Type.Union([
			Type.Literal("completed"),
			Type.Literal("failed"),
			Type.Literal("cancelled"),
			Type.Literal("interrupted"),
			Type.Literal("cleanup-blocked"),
		]),
		output: Type.Optional(ArtifactRefSchema),
		structuredOutput: Type.Optional(Type.Unknown()),
		usage: UsageSchema,
		usageComplete: Type.Boolean(),
		sandboxCleanup: CleanupOutcomeSchema,
		workspaceCleanup: CleanupOutcomeSchema,
		truncated: Type.Boolean(),
	},
	{ additionalProperties: false },
);
export type RunResult = Static<typeof RunResultSchema>;

function cleanupIsProved(result: RunResult): boolean {
	return (
		result.sandboxCleanup === "proved" &&
		(result.workspaceCleanup === "proved" ||
			result.workspaceCleanup === "not-needed")
	);
}

export function isRunResult(value: unknown): value is RunResult {
	if (!Value.Check(RunResultSchema, value)) return false;
	const result = value as RunResult;
	const proved = cleanupIsProved(result);
	if (result.status === "completed") return proved;
	if (result.status === "cleanup-blocked") return !proved;
	return true;
}

export const SubagentRuntimeContractSchema = Type.Object(
	{
		schema: Type.Literal("pi-subagent-runtime"),
		contractRevision: Type.Literal(CONTRACT_REVISION),
		features: Type.Object(
			{
				nativeSessionBackend: Type.Boolean(),
				gondolinSandbox: Type.Boolean(),
				background: Type.Literal(false),
				survivesSeatExit: Type.Literal(false),
				steering: Type.Boolean(),
				followUp: Type.Boolean(),
				structuredOutput: Type.Boolean(),
				preflight: Type.Boolean(),
				idempotentLaunch: Type.Boolean(),
				resume: Type.Boolean(),
				worktrees: Type.Boolean(),
				publicNetworkEgress: Type.Boolean(),
				explicitResources: Type.Boolean(),
				ambientExtensionsControl: Type.Boolean(),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);
export type SubagentRuntimeContract = Static<
	typeof SubagentRuntimeContractSchema
>;

export const SUBAGENT_RUNTIME_CONTRACT: SubagentRuntimeContract = {
	schema: "pi-subagent-runtime",
	contractRevision: CONTRACT_REVISION,
	features: {
		nativeSessionBackend: true,
		gondolinSandbox: true,
		background: false,
		survivesSeatExit: false,
		steering: false,
		followUp: false,
		structuredOutput: true,
		preflight: true,
		idempotentLaunch: false,
		resume: false,
		worktrees: true,
		publicNetworkEgress: true,
		explicitResources: true,
		ambientExtensionsControl: true,
	},
};
