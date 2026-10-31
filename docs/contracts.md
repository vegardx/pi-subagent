# Contracts

The examples in this document are design contracts, not implemented APIs.

## Delegation envelope

```ts
interface DelegatedTask {
	goal: string;
	context: string[];
	instructions: string[];
}
```

`goal` defines the required result, `context` carries bounded caller-supplied
facts, and `instructions` defines task-specific actions. Transcript inheritance
uses a separate `ContextMode`; it is never implicit.

## Identity hierarchy

```text
Owner
  Run
    Attempt
      Pi session
      Gondolin VM
      Workspace
```

```ts
type OwnerId = string;
type OperationId = string;
type RunId = string;
type AttemptId = string;
type SessionId = string;
type SandboxId = string;
type WorkspaceId = string;

interface SandboxIdentity {
	id: SandboxId;
	backend: "gondolin";
	gondolinVersion: string;
	imageIdentity: string;
	policySha256: string;
	capacityLeaseId: string;
	capacitySlot: number;
}
```

A VM belongs to one attempt and is never adopted by another attempt.
`OperationId` is chosen by the caller and makes logical launch idempotent across
concurrent seats and seat replacement. It does not keep an attempt alive after
its owning seat exits.

## Request and preflight

```ts
interface SubagentRequest {
	operationId: OperationId;
	agent: AgentSelector;
	agentRoots?: string[]; // absolute; at most 8
	task: DelegatedTask;
	contextMode: "fresh" | "fork";
	model?: ExactModelRequest | "inherit";
	tools?: string[];
	preloadSkills?: string[];
	contextScopes: Array<"global" | "project">;
	workspace: WorkspaceRequest;
	ceiling?: DelegationCeiling;
	memoryBytes?: number;
	outputSchema?: JsonSchema;
	limits: RunLimits;
}

interface DelegationCeiling {
	workspaceModes?: Array<"read-only" | "worktree">; // at least one
	tools?: string[];                                 // at most 64
}

type WorkspaceRequest =
	| { mode: "read-only"; cwd: string; startAt?: CommitId }
	| { mode: "worktree"; cwd: string; startAt?: CommitId };

type CommitId = string; // ^[a-f0-9]{40,64}$

interface RunLimits {
	cumulativeRuntimeMs: number; // cumulative across every attempt
	attemptTimeoutMs: number;    // one attempt's deadline, VM boot excluded
	totalTokens?: number;        // optional all-traffic guard
	cost: number;                // provider-reported dollars
	outputBytes: number;
	workspaceWriteBytes: number;
	retries: number;
	resumes: number;
}

interface SubagentPreflight {
	preflightId: string;
	launchPlan: AgentLaunchPlan;
	warnings: PreflightWarning[];
}

interface MutationContext {
	operationId: OperationId;
	callerFence?: { scope: string; generation: number };
}

interface OwnerRegistration {
	id: OwnerId;
	parentSessionId?: string;
	parentSessionFile?: string;
	workflowRunId?: string;
	resultDestination?: string;
}
```

`startAt` is the hand-off commit the workspace is checked out at. Preflight
refuses, by name, a commit the repository at `cwd` does not hold ("workspace
startAt commit does not exist in the repository"), one no
`refs/pi-subagent/handoffs/<run-id>/<attempt-id>` ref points at ("workspace
startAt is not the target of a hand-off ref in this repository"), and one whose
sole parent is not the current HEAD ("workspace startAt must have exactly one
parent, the repository HEAD"). The commit is bound into `baselineSha256` and
recorded as `workspace.startAt` in the launch plan, so retry and resume start at
it again. A `worktree` workspace is checked out at the commit on a private
branch; a `read-only` workspace gets a detached host checkout of it, mounted
read-only and removed when the attempt's VM is closed. Without `startAt` both
modes behave as before: the worktree starts at HEAD and a read-only attempt
mounts the live checkout. The guest never applies a hand-off and has no `git`;
the host prepares the tree.

`agentRoots` lets an owner that ships agent definitions with its own package
name the directories holding them. Each entry must be absolute; a relative entry
fails preflight with `agent root must be absolute`. A definition's own templates
win: the roots resolve first and the service's own discovery only fills a name
no root defines, so a global or trusted-project definition of the same name
cannot shadow a shipped one, and a name no source defines still fails with
`agent not found: <name>`. Roots are read as one `package`-scope source set, so
two roots that define the same name are refused with
`duplicate agent in scope: package:<name>` rather than silently ordered. A
definition resolved from a request root loads under `package` scope and is
bound into the launch plan by canonical path and digest exactly like any other
definition: the launch plan and its `agent` resource grant name the root's file,
and the launch re-resolves it and rejects a definition that changed after
preflight. A root that does not exist contributes nothing. There is no way to
customize a shipped definition by defining a project or global agent of the same
name.

`model` says which model the launch runs on, in one of three ways. An
`ExactModelRequest` pins provider, id, and thinking level. The literal `inherit`
asks for the host session's current model and thinking level, which pi-subagent
resolves at preflight through the registered session-model provider; with no
provider, or a provider that answers with nothing, preflight refuses with
`model inherit: no session model to inherit`. An absent `model` leaves the agent
definition's own pin in force. A definition's `allowedModels` fences the choice:
an exact entry admits exactly that `provider/id:thinking`, and the entry
`inherit` admits whatever the host session answers with, any model at any
thinking level, so for an inherited model the fence lives at the host. A
definition without `inherit` refuses an inherited request with
`model exceeds ceiling: anthropic/opus-5:high (template admits
github-copilot/gpt-5.6-luna:low, not inherit)`.

`ceiling` is a bound the host puts on one delegation, stated in this runtime's
own vocabulary: workspace modes and tool names, never a host's own mode names.
The launch's effective allowance is the agent definition's declared allowance
intersected with the ceiling, so a ceiling only ever narrows. An absent
`ceiling`, or an absent sub-field, is no bound on that axis. Preflight refuses by
name: a requested mode the host does not allow fails with
`workspace mode exceeds host ceiling: worktree (host allows read-only)`, and a
requested tool outside the ceiling fails with `tool exceeds host ceiling: write`.
The ceiling that applied is recorded in the launch plan, sorted, and is part of
the launch identity digest and the persisted run and attempt records.

`cost` is provider-reported spend in dollars using Pi's configured model pricing
and message usage. A model configured with zero rates is treated as free; the
current Pi model contract does not distinguish free pricing from unavailable
pricing metadata. The service defaults to a $100 maximum declared task cost and
embedders may configure that policy. The task's
explicit cost limit must fit both its agent ceiling and the service policy.
`totalTokens` is optional; when absent, cost and runtime remain the task budget
authorities.

`memoryBytes` is the guest VM memory grant. It is a multiple of 64 MiB from
1 GiB (`MIN_MEMORY_BYTES`) to 4 GiB (`MAX_MEMORY_BYTES`). The floor is a
workload floor, not the boot floor: the pinned guest image boots at 96 MiB and
fails to reach readiness at 64 MiB (`docs/qualification`), and 1 GiB leaves the
guest kernel, its services, and Node-based toolchains such as npm and `tsc`
room to run. Guest scratch paths live on the root disk, not in memory, so the
grant is for processes only. An agent definition declares the
ceiling; a request may only narrow it, never below the floor. When the request
omits it, the plan uses the agent ceiling; when the agent definition omits it,
the ceiling is 1 GiB (`DEFAULT_MEMORY_BYTES`). A request above the
ceiling fails preflight with `memory request exceeds agent ceiling`. Guest CPU
count is fixed at one and is not a per-agent knob.

Preflight resolves and hashes all effective resources without starting a model
session or VM. Project trust, provenance, canonical paths, symlink policy,
public-egress policy, sandbox image, and caller operation identity are part of
the plan.

The initial release does not accept arbitrary child extensions. A capability
implemented by trusted host code must be declared through a pi-subagent-owned
adapter and represented in the launch identity.

## Agent definition frontmatter

```yaml
name: reviewer
model:
  provider: github-copilot
  id: gpt-5.6-luna
  thinking: low
allowedModels: [github-copilot/gpt-5.6-luna:low, inherit]   # optional; default [the pin]
tools: [read, grep]
preloadSkills: []
contextScopes: [project]
workspaceModes: [read-only]
memoryBytes: 2147483648   # optional; default and minimum 1 GiB, maximum 4 GiB
limits:
  cumulativeRuntimeMs: 600000
  attemptTimeoutMs: 300000
  cost: 10
  outputBytes: 1048576
  workspaceWriteBytes: 0
  retries: 1
  resumes: 1
```

Frontmatter is strict: unknown keys, a `memoryBytes` that is not a multiple
of 64 MiB, and a `memoryBytes` below 1 GiB or above 4 GiB are rejected at
discovery with `invalid agent frontmatter`, naming the schema violation. Every declared value is a ceiling, never a floor.

`allowedModels` holds `provider/id:thinking` routes and the entry `inherit`, and
must contain the `model` pin. It defaults to exactly that pin, so a definition
admits an inherited model only by saying so.

## Effective launch plan

```ts
interface AgentLaunchPlan {
	schema: "pi-subagent-launch";
	contractRevision: number;
	operationId: OperationId;
	owner: OwnerGrant;
	runId: RunId;
	attemptId: AttemptId;
	agent: ResolvedAgentDefinition;
	task: DelegatedTask;
	context: ResolvedContextProjection;
	model: { provider: string; id: string; thinking: string };
	modelSource: "request" | "template" | "inherited";
	cwd: "/workspace";
	tools: ToolGrant[];
	preloadSkills: string[];
	skillCatalog: SkillGrant[];
	contextScopes: Array<"global" | "project">;
	contextFiles: ContextFileGrant[];
	forkContext?: ForkContextGrant;
	workspace: WorkspaceGrant;
	ceiling?: DelegationCeiling;
	sandbox: GondolinGrant;
	network: NetworkGrant;
	outputSchema?: JsonSchema;
	limits: RunLimits;
	projectTrust?: ProjectTrustReceipt;
	identitySha256: string;
}

interface GondolinGrant {
	backend: "gondolin";
	packageVersion: string;
	imageIdentity: string;
	mountPolicySha256: string;
	networkPolicySha256: string;
	memoryBytes: number;
	guestDiskBytes: number;
	workspaceWriteBytes: number;
	capacityPolicySha256: string;
	rootfsPolicySha256: string;
}

interface NetworkGrant {
	mode: "public-egress";
	blockInternalRanges: true;
}
```

Agent-required and request-selected `contextScopes` are unioned. `global`
projects the Pi agent-directory context file; `project` projects Pi's normal
ancestor context chain only after project trust succeeds. Files are bounded,
digest-bound, injected through Pi's context-file mechanism, and exposed through
synthetic read-only guest `/context` mounts. Repository context symlinks may not
escape the selected checkout. Transcript inheritance remains separately
controlled by `contextMode`.

`model` is always exact: a plan never carries `inherit`. `modelSource` records
which of the three ways supplied it, so the persisted record says where the model
came from, and both fields are part of the launch identity digest. A retry or
resume reruns the plan's recorded model rather than resolving the session again.

`ceiling` records the host bound the plan was compiled under, present only when
the request carried one. A launch plan without it was compiled with no host
bound.

`sandbox.guestDiskBytes` is the virtual size of the attempt's root disk, 4 GiB
(`GUEST_ROOTFS_BYTES`). The root disk is a Gondolin copy-on-write qcow2 overlay
over the pinned image, created per VM in the host's temporary directory, grown
on demand, and deleted when the VM closes; nothing persists between attempts.
Gondolin's default scratch tmpfs set is disabled, so `/tmp`, `/var/tmp`,
`/var/cache`, `/var/log`, and `/root` are on that disk rather than in guest
memory. `rootfsPolicySha256` digests that layout (`GUEST_ROOTFS_POLICY`: mode
`cow`, size, tmpfs `root-disk`) and binds it into the launch identity next to
the mount, network, and capacity policies; the sandbox record carries the same
policy. Host disk exposure is bounded by `maxSlots` x 4 GiB plus qcow2
metadata, 64 GiB at the default sixteen slots, reached only when every
attempt fills its disk.

`sandbox.memoryBytes` is the resolved per-run memory grant, so it is part of the
launch identity digest and of the persisted run and attempt records. Host VM
capacity stays slot-counted: host memory exposure is `maxSlots` x the per-run
grant, which for the default sixteen slots is 16 GiB at the 1 GiB default and
64 GiB at the 4 GiB ceiling. There is no separate total-memory budget; slots are held by OS-owned localhost
listeners and a byte budget would require durable fenced per-slot accounting
that the listener scheme does not provide.

Resource grants include canonical path, source provenance, content/tree digest,
and classification. Referenced resources and sandbox capabilities are
revalidated immediately before launch. The plan is immutable after launch
authority is committed.

## Service

```ts
interface SubagentService {
	readonly contract: SubagentRuntimeContract;
	forOwner(owner: OwnerRegistration): SubagentClient;
	listRuns(query?: RunQuery): Promise<RunPage>;
	inspectRun(runId: RunId): Promise<RunInspection>;
	runLogs(runId: RunId, options?: LogOptions): Promise<RunLogPage>;
	subscribe(listener: (event: RunObservation) => void): () => void;
	prune(options?: PruneOptions): Promise<RetentionReport>;
}

interface SubagentClient {
	preflight(request: SubagentRequest): Promise<SubagentPreflight>;
	launch(
		context: MutationContext,
		preflightId: string,
		expectedIdentitySha256: string,
	): Promise<RunReceipt>;
	findByOperation(operationId: OperationId): Promise<RunReceipt | undefined>;
	listRuns(query?: OwnerRunQuery): Promise<RunPage>;
	status(runId: RunId): Promise<RunStatus>;
	logs(runId: RunId, options?: LogOptions): Promise<RunLogPage>;
	wait(runId: RunId, options?: WaitOptions): Promise<RunResult>;
	steer(
		context: MutationContext,
		runId: RunId,
		input: ControlInput,
	): Promise<ControlReceipt>;
	followUp(
		context: MutationContext,
		runId: RunId,
		input: ControlInput,
	): Promise<ControlReceipt>;
	interrupt(
		context: MutationContext,
		runId: RunId,
		reason: StopReason,
	): Promise<InterruptReceipt>;
	retry(
		context: MutationContext,
		runId: RunId,
		policy?: RetryPolicy,
	): Promise<RunReceipt>;
	resume(
		context: MutationContext,
		runId: RunId,
		input?: ResumeInput,
	): Promise<RunReceipt>;
	reconcile(
		context: MutationContext,
		runId: RunId,
	): Promise<ReconcileResult>;
	exportArtifact(
		runId: RunId,
		artifact: ArtifactRef,
		maxBytes?: number,
	): Promise<ArtifactExport>;
	exportHandoff(
		runId: RunId,
		options?: { maxBytes?: number },
	): Promise<HandoffExport>;
	release(
		context: MutationContext,
		runId: RunId,
	): Promise<CleanupReceipt>;
	abandon(context: MutationContext, runId: RunId): Promise<RunReceipt>;
	pin(runId: RunId, reason: string): Promise<RetentionPin>;
	unpin(runId: RunId): Promise<boolean>;
}
```

`forOwner` returns an opaque client bound to one trusted extension owner; model
input cannot choose or impersonate an owner. This is authorization within the
trusted seat process, not a boundary against arbitrary installed extensions.
Run IDs are not bearer authorization.

`launch` consumes one exact unexpired preflight identity. It creates the native
session and VM in the current seat. It does not create detached work. A seat
exit interrupts every active attempt. The next seat may call `resume`, which
creates a new attempt and VM after validation; it does not reconnect to the old
VM.

```ts
interface ResumeInput {
	continueFromHandoff: true;
	message: string; // non-blank, at most 65536 UTF-8 bytes
}
```

Without `input`, `resume` continues an interrupted run in its retained worktree
with a fixed resume prompt. With `input`, it continues the session of a
`completed`, `failed`, or `cancelled` `worktree` run that has a hand-off: the
new attempt restores the run's Pi session file, delivers `message` verbatim as
the session's next user message after the restored transcript, and works in a
new worktree checked out at the run's latest hand-off commit. That worktree's
record carries `baselineHead` = the hand-off's baseline (the original HEAD)
and `startCommit` = the hand-off commit. The attempt reruns the plan's
recorded model, consumes one `limits.resumes`, and draws on the remaining
run-wide runtime, token, and cost budgets. The failure disposition does not
gate it. It refuses by name: a run that is not a worktree run, a run in
another status, a run without a hand-off, a blank or oversized message, and a
run with no resumes left; the session and workspace revalidation of a plain
resume also applies, and a repository HEAD that moved since the hand-off's
baseline fails as "workspace changed before resume". A consumer that resumes
an implementer once should launch it with `limits.resumes: 1`, the default the
`subagent` tool uses; each resume, plain or at a hand-off, consumes one. The
operator surfaces do not offer this resume; it is service-only. A run that
carries a hand-off refuses `retry`, which would start over without it.

`prune` defaults to dry-run, reports age/budget selection and protected reasons,
and moves applied selections to recoverable trash under a cross-process
retention lease plus per-run fencing. Owner pins protect the complete linked run
graph. Active, interrupted, cleanup-blocked, pinned, and unreleased-worktree runs
are never ordinary prune candidates.

`exportArtifact` returns bounded verified bytes plus media type and digest so a
caller can import them into its own retention domain. `release` completes only
retained workspace cleanup through the owning service.

```ts
interface HandoffRef {
	runId: RunId;
	attemptId: AttemptId;
	baselineHead: string;
	handoffCommit: string;
	format: "git-format-patch";
	sha256: string;
	bytes: number;
	mediaType: "application/x-git-format-patch";
}

interface HandoffExport {
	ref: HandoffRef;
	content: Buffer;
}
```

`exportHandoff` returns the writing attempt's handoff as bounded bytes so a
consumer that must never read private branches, refs, or host paths can import
workflow-owned evidence. The content is the binary-safe
`git format-patch --binary --stdout <baselineHead>..<handoffCommit>` output for
the single handoff commit, produced by the host with `--no-replace-objects` and
every `format.*` and `diff.*` rendering option pinned, without a diffstat or Git
version signature. Bytes and digest are identical for the same baseline/handoff
pair, the same Git build, and unchanged repository attributes: `.gitattributes`
content is part of the commit pair, and `.git/info/attributes` is treated as
part of the repository identity, so editing it changes the rendering. Consumers
verify `sha256` and `bytes`, then `git am` or `git apply --index` the patch onto
`baselineHead`. The handoff must be exactly one non-merge commit whose sole
parent is `baselineHead`; anything else is refused. The host squashes: whether
the worktree started at HEAD, at a `startAt` hand-off, or at the run's own
hand-off for a resume, capture writes one commit whose tree is the worktree's
final tree and whose parent is `baselineHead`, so a hand-off started from
another carries both. `exportHandoff` returns the run's latest hand-off and
`HandoffRef.attemptId` names the attempt that captured it: after a resume at
the hand-off, the resumed attempt's commit when it changed something, otherwise
still the earlier attempt's. Each attempt keeps its own
`refs/pi-subagent/handoffs/<run-id>/<attempt-id>` ref; there is no run-level
pointer. "No changes"
means the final tree equals the start commit's tree, and then there is no
handoff; a final tree equal to the baseline's while starting at a hand-off is
refused by name rather than exported as an empty patch. Export is owner-scoped like
`exportArtifact`, requires a durable `completed`, `failed`, `cancelled`, or
`cleanup-blocked` result whose `handoff` carries a `handoffCommit`, holds the
run lease while reading the repository, and is bounded by `maxBytes` and the
absolute 64 MiB Git output cap. A run that changed nothing has no handoff commit
and is refused; an empty patch is never exported. Each export appends one
`handoff-exported` receipt carrying the `HandoffRef`. Release removes only the
reservation branch; the handoff commit stays reachable through a durable
`refs/pi-subagent/handoffs/<run-id>/<attempt-id>` ref until retention prunes the
run, so consumers may export before or after release but must export or pin
before the run becomes ordinary prune history. `abandon` permanently
terminalizes an interrupted run after sandbox cleanup is proved and any retained
workspace can be released safely. Cleanup-blocked runs must reconcile first.

The service owns one typed action projection consumed unchanged by the inspector
and direct commands:

| Run condition | Operator actions |
| --- | --- |
| active, controllable | steer, follow-up, stop |
| active, not controllable | stop |
| retry-eligible failed | retry plus terminal retention actions |
| interrupted | resume when eligible; abandon when sandbox and retained-workspace cleanup can be proved |
| cleanup-blocked | reconcile, plus release-workspace when the retained workspace is already proved releasable; export-handoff when a handoff commit exists |
| completed/failed/cancelled/abandoned | pin or unpin; export-output when present; export-handoff when a handoff commit exists (never for abandoned) |

Pin and unpin affect retention only. Operator surfaces do not offer them for
active, interrupted, or cleanup-blocked runs because those states are already
protected; trusted owner clients may still create a pin without changing
lifecycle state.

## Service provider

The extension registers one lazy provider on Pi's process-local event bus. A
trusted peer extension acquires the exact extension-owned service through the
`@vegardx/pi-subagent/service-provider` export and supplies its current
`ExtensionContext`:

```ts
interface SubagentServiceProvider {
	readonly contract: SubagentRuntimeContract;
	acquire(context: ExtensionContext): Promise<SubagentService>;
}
```

Discovery fails closed when the provider is absent, duplicated, or does not
match the current immutable runtime contract. Acquisition re-runs discovery
after the asynchronous provider call and rejects removal or replacement before
returning the service. Registration itself does not initialize the
model runtime, Gondolin assets, capacity manager, or service store. The
subagent extension alone owns provider removal and service shutdown. Consumers
must not cache the service across Pi session replacement or reload.

The event bus is an in-process composition mechanism among trusted extensions,
not an authorization boundary. Owner-bound clients still scope service access;
model input cannot access the provider API directly.

## Delegation ceiling provider

The model-facing `subagent` tool builds its own requests, so a host cannot put a
`ceiling` in them. A host registers one provider on the same process-local event
bus through the `@vegardx/pi-subagent/ceiling-provider` export:

```ts
type DelegationCeilingProvider = () => DelegationCeiling | undefined;

function registerDelegationCeilingProvider(
	events: EventBus,
	provider: DelegationCeilingProvider,
): () => void;
```

The tool consults the provider at every launch and attaches the answer as the
request's `ceiling`. Exactly one provider may be registered: a second
registration is refused with `A pi-subagent delegation ceiling provider is
already registered.` and leaves the first in place. No provider, or a provider
that answers with `undefined`, is no bound. Resolution fails closed on a ceiling
that violates the contract rather than launching unbounded. The host states the
bound in workspace modes and tool names; pi-subagent never learns the host's own
mode names.

## Session model provider

A request may ask to run on the host session's model, which pi-subagent cannot
see. A host registers one provider on the same process-local event bus through
the `@vegardx/pi-subagent/session-model-provider` export:

```ts
type SessionModelProvider = () => ExactModelRequest | undefined;

function registerSessionModelProvider(
	events: EventBus,
	provider: SessionModelProvider,
): () => void;

function resolveSessionModel(events: EventBus): ExactModelRequest | undefined;
```

Preflight consults the provider whenever a request carries `model: "inherit"`
and compiles the plan with the exact answer. The model-facing `subagent` tool
accepts the same literal in its `model` parameter; because the tool synthesizes
its own definition it resolves the answer at the call and pins it. Exactly one
provider may be registered: a second registration is refused with `A pi-subagent
session model provider is already registered.` and leaves the first in place. No
provider, or a provider that answers with `undefined`, refuses an inherited
request with `model inherit: no session model to inherit`. Resolution fails
closed on an answer that violates the contract rather than compiling a model no
host stands behind.

## Control receipt

```ts
interface ControlReceipt {
	operationId: string;
	sequence: number;
	state: "accepted-by-session" | "missed" | "failed";
}
```

`accepted-by-session` means the child session queued the input; it does not
claim that the model followed it. Input a session input handler consumes before
it reaches the agent is `failed`.
Duplicate operation IDs replay the prior receipt. There is no durable control
queue while the seat is absent.

## Runtime capability contract

```ts
interface SubagentRuntimeContract {
	schema: "pi-subagent-runtime";
	contractRevision: number;
	features: {
		nativeSessionBackend: boolean;
		gondolinSandbox: boolean;
		background: false;
		survivesSeatExit: false;
		steering: boolean;
		followUp: boolean;
		structuredOutput: boolean;
		preflight: boolean;
		idempotentLaunch: boolean;
		resume: boolean;
		classifiedFailures: boolean;
		cumulativeRuntimeBudget: boolean;
		costFirstBudgets: boolean;
		retryBackoff: boolean;
		deepReconciliation: boolean;
		worktrees: boolean;
		handoffExport: boolean;
		vmMemoryCeiling: boolean;
		workspaceBudgetRefusal: boolean;
		publicNetworkEgress: boolean;
		explicitResources: boolean;
		ambientExtensionsControl: boolean;
		hostBrokeredTools: boolean;
		agentRootsFirst: boolean;
		delegationCeiling: boolean;
		sessionModelInherit: boolean;
		workspaceStartAt: boolean;
		resumeAtHandoff: boolean;
		capacityWait: boolean;
	};
	capacity: {
		maxSlots: number; // integer 1..32
	};
}
```

The current revision is 12. `handoffExport` states that `exportHandoff`,
`HandoffRef`, the `export-handoff` action, durable handoff refs, and the
`handoff-exported` receipt are implemented. `vmMemoryCeiling` states that agent
definitions carry an optional `memoryBytes` ceiling, that a request may narrow
it, and that the resolved value is bound into the launch plan and the sandbox
identity. `workspaceBudgetRefusal` states that an exhausted `workspaceWriteBytes`
budget refuses guest writes with `EDQUOT` and classifies the attempt failure as
`workspace-budget`. `agentRootsFirst` states that `SubagentRequest.agentRoots`
is accepted and that those roots resolve ahead of the service's own discovery;
a consumer that requires a discovered definition to shadow a shipped one must
refuse this runtime. `delegationCeiling` states that `SubagentRequest.ceiling`
bounds a launch in workspace modes and tool names, that the compiled launch plan
records the ceiling it applied, and that a host may register one ceiling provider
that the `subagent` tool consults at every launch. `sessionModelInherit` states
that a request's `model` may be the literal `inherit`, that a host may register
one session-model provider which preflight and the `subagent` tool consult, that
a definition's `allowedModels` may admit `inherit`, and that the compiled plan
records the resolved exact model and its `modelSource`. `workspaceStartAt`
states that `WorkspaceRequest.startAt` is accepted and refused by name unless it
is a hand-off of the current HEAD, that both workspace modes start at it, and
that the export squashes onto `baselineHead`. Revision 10 adds `startAt` to the
request, the persisted launch plan, and the run record, `startCommit` to the
worktree record, and the snapshot record, so revision 9 state is not read.
`resumeAtHandoff` states that `resume` accepts `ResumeInput`, continues the
session in a worktree at the run's latest hand-off, delivers the message as the
next user turn, and exports a hand-off squashed onto the original baseline that
replaces the earlier one. It changes no persisted shape, so it does not advance
the revision; a consumer requires it by name. Revision 11 raises the
`memoryBytes` floor and default from 64 MiB and 512 MiB to 1 GiB; it adds no
feature. A persisted revision 10 launch plan or definition may carry memory
below the floor, so revision 10 state is not read.
Revision 12 adds `capacity.maxSlots`, the number of attempt VMs this host runs
at once across every seat, so a host can cap its own fan-out. It is the
operator's `maxSlots` setting in `<agentDir>/subagents/settings.json`
(`{ "maxSlots"?: integer 1..32 }`, no other keys; default 16). A settings file
that does not match is refused when the extension loads, by path, never partly
applied. Every seat sharing `<agentDir>/subagents/capacity` must agree: the
first seat records `maxSlots` and the derived port range in `policy.json`
there, and a seat whose setting differs refuses to execute attempts with a
message naming both slot counts and that file. `capacityWait` states that an
attempt whose host has no free slot waits for one, up to `capacityWaitMs`
(10 minutes, clamped to the run's remaining cumulative runtime), without
charging the wait to `attemptTimeoutMs`, and that an attempt that never gets a
slot fails with the failure code `capacity`, origin `service`, retry `backoff`,
and complete zero usage. Revision 12 also makes `usageComplete` true for any
attempt that ended before its model session existed. It adds
`sandbox.rootfsPolicySha256` to the launch grant: attempts boot the pinned
guest image on a 4 GiB copy-on-write root disk with no scratch tmpfs, and
`guestDiskBytes` is that disk's size. As with every revision, revision 11 state
is not read.
Consumers check the exact contract
revision and required features rather than
infer support from package versions. Revisions are not backwards-compatible:
a consumer either supports the current revision or refuses to start. The
project does not provide compatibility aliases, adapters, or migration shims.

## Outcomes and states

```ts
type RunStatus =
	| "queued"
	| "active"
	| "stopping"
	| "completed"
	| "failed"
	| "cancelled"
	| "abandoned"
	| "interrupted"
	| "cleanup-blocked";

type AttemptStatus =
	| "preparing"
	| "running"
	| "settling"
	| "completed"
	| "failed"
	| "cancelled"
	| "interrupted";

type CleanupOutcome =
	| "proved"
	| "not-needed"
	| "retained"
	| "blocked"
	| "unknown";
```

A run aggregates attempts. Retry and resume terminate the prior attempt and
create a new one. Any post-side-effect path enters settlement before the run can
be terminal.

Completed results have no failure. Every failed, cancelled, abandoned,
interrupted, or cleanup-blocked result has exactly one bounded
`ClassifiedFailure`. Abandonment uses `operator-abandoned`, operator origin, and
retry `never`:

```ts
interface ClassifiedFailure {
	code: FailureCode;
	origin:
		| "model"
		| "operator"
		| "persistence"
		| "provider"
		| "sandbox"
		| "service"
		| "tool"
		| "workspace";
	retry: "never" | "manual" | "backoff" | "resume" | "reconcile";
	message: string;
	guidance: string;
	retryAfterMs?: number;
}
```

Unknown failures fail closed to `reconcile`. Explicit retry accepts only `manual`
or elapsed `backoff`; resume accepts only `resume`, except a resume at the
run's hand-off, which follows a terminal result. Every attempt records
measured `runtimeMs`, and retry/resume subtract runtime, configured total model
tokens, and provider-reported cost from the current remaining plan before
creating a fresh attempt. When `totalTokens` is configured, it consumes the
reported `Usage.totalTokens`, including input, output, cache-read, and cache-write
traffic. Without it, cost and runtime remain authoritative.

A run may be `completed` only when VM cleanup is proved and workspace cleanup is
`proved` or `not-needed`. A deliberately retained worktree is represented as
`retained` and leaves the run `cleanup-blocked` until explicit `release` proves
cleanup. Blocked, retained, or unknown cleanup can never accompany `completed`.

```mermaid
stateDiagram-v2
    [*] --> queued
    queued --> active
    active --> completed
    active --> failed
    active --> interrupted
    active --> stopping
    stopping --> cancelled
    active --> cleanupBlocked
    stopping --> cleanupBlocked
    cleanupBlocked: cleanup-blocked
    failed --> queued: retry
    interrupted --> queued: resume
    completed --> queued: resume at hand-off
    failed --> queued: resume at hand-off
    cancelled --> queued: resume at hand-off
    interrupted --> abandoned: abandon
```

## Result

```ts
interface RunResult {
	runId: RunId;
	status:
		| "completed"
		| "failed"
		| "cancelled"
		| "abandoned"
		| "interrupted"
		| "cleanup-blocked";
	output?: ArtifactRef;
	structuredOutput?: unknown;
	usage: Usage;
	usageComplete: boolean;
	runtimeMs: number;
	failure?: ClassifiedFailure;
	sandboxCleanup: CleanupOutcome;
	workspaceCleanup: CleanupOutcome;
	truncated: boolean;
}
```

`usageComplete` is `false` only when a model session existed and the attempt
did not complete, because an interrupted model turn's usage may be partial. An
attempt that ended before its session existed, such as a `capacity` refusal or
a VM that failed to construct or start, made no model call and reports its
zero usage as complete.

Limits define per-attempt timeout, cumulative runtime, optional total model
tokens, provider-reported dollar cost, output, logs, events, artifact bytes,
retries, and resume count. At 70% and 90% of configured total-token,
provider-reported cost, cumulative-runtime, or attempt-timeout pressure, the
runtime persists a single stage receipt per attempt and queues progressively
stronger convergence steering. One unified stage per attempt prevents competing
budget dimensions from emitting duplicate notices.
Runtime stages are scheduled by wall clock; token stages are evaluated after
turn usage is recorded. Partial usage and truncation remain visible after
failure.
