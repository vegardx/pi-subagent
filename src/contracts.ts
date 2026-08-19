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

export const FailureCodeSchema = Type.Union([
	Type.Literal("authentication"),
	Type.Literal("cancellation"),
	Type.Literal("lease-loss"),
	Type.Literal("model-output"),
	Type.Literal("mount-policy"),
	Type.Literal("network-policy"),
	Type.Literal("persistence"),
	Type.Literal("provider-transient"),
	Type.Literal("resource-drift"),
	Type.Literal("sandbox-capability"),
	Type.Literal("sandbox-cleanup"),
	Type.Literal("sandbox-launch"),
	Type.Literal("seat-interruption"),
	Type.Literal("timeout"),
	Type.Literal("tool"),
	Type.Literal("trust"),
	Type.Literal("unknown"),
	Type.Literal("validation"),
	Type.Literal("workspace"),
]);
export type FailureCode = Static<typeof FailureCodeSchema>;

export const ClassifiedFailureSchema = Type.Object(
	{
		code: FailureCodeSchema,
		origin: Type.Union([
			Type.Literal("model"),
			Type.Literal("operator"),
			Type.Literal("persistence"),
			Type.Literal("provider"),
			Type.Literal("sandbox"),
			Type.Literal("service"),
			Type.Literal("tool"),
			Type.Literal("workspace"),
		]),
		retry: Type.Union([
			Type.Literal("never"),
			Type.Literal("manual"),
			Type.Literal("backoff"),
			Type.Literal("resume"),
			Type.Literal("reconcile"),
		]),
		message: Type.String({ minLength: 1, maxLength: 4096 }),
		guidance: Type.String({ minLength: 1, maxLength: 1024 }),
		retryAfterMs: Type.Optional(
			Type.Integer({ minimum: 1_000, maximum: 300_000 }),
		),
	},
	{ additionalProperties: false },
);
export type ClassifiedFailure = Static<typeof ClassifiedFailureSchema>;

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
		runtimeMs: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		failure: Type.Optional(ClassifiedFailureSchema),
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
	if (result.status === "completed") {
		return proved && result.failure === undefined;
	}
	if (result.failure === undefined) return false;
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
				classifiedFailures: Type.Boolean(),
				cumulativeRuntimeBudget: Type.Boolean(),
				retryBackoff: Type.Boolean(),
				deepReconciliation: Type.Boolean(),
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
		steering: true,
		followUp: true,
		structuredOutput: true,
		preflight: true,
		idempotentLaunch: true,
		resume: true,
		classifiedFailures: true,
		cumulativeRuntimeBudget: true,
		retryBackoff: true,
		deepReconciliation: true,
		worktrees: true,
		publicNetworkEgress: true,
		explicitResources: true,
		ambientExtensionsControl: true,
	},
};
