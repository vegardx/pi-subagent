# pi-subagent

Native subagent runtime for [Pi](https://pi.dev).

This repository is in active implementation and qualification. The supported
host target is macOS on Apple Silicon; the guest remains Linux under Gondolin.
Other hosts may pass build checks but are not supported or release-qualified.

## Goal

Provide one reusable implementation for delegated Pi agents:

- native in-process Pi `AgentSession`s with explicit resource projection;
- one Gondolin Linux micro-VM per active attempt;
- VM-backed built-in tools with fail-closed host-write containment;
- exact host-brokered public-network tools whose credentials remain in the Pi
  seat;
- read-only checkout access for readers and private worktrees for writers;
- host-owned models, credentials, Git handoffs, persistence, and cleanup;
- cancellation, classified failure, backoff, fresh-VM retry/resume, and reconciliation;
- cumulative runtime/provider-cost/optional-total-token budgets, 70%/90% convergence steering,
  and bounded artifacts with full cache-usage telemetry;
- a typed service used by both the model-facing tool and workflow engines.

Active attempts stop when the Pi seat exits or reloads. Their session and
workspace state persist for explicit resume in a fresh VM. The initial runtime
does not provide detached execution or survival across seat exit.

`pi-subagent` owns physical agent execution. It does not schedule workflow
stages or define delivery policy.

## Operator UX

Use `/subagents` for the current-project run inspector. It provides bounded
Overview, Activity, Result, and Technical tabs, live status updates, state-valid
actions projected by the service, search/filtering, current/all-project scope,
retention preview, and separate ongoing/needs-action widget lines. Interrupted
runs can be explicitly abandoned after cleanup proof; cleanup-blocked runs must
reconcile first. During an active parent turn, `Alt+S` opens the inspector
without submitting editor input; steer/follow-up appear only after the child
session reports control readiness. Direct commands use the same service
authority:

```text
/subagents list [--all]
/subagents show|status <run-prefix>
/subagents logs|wait <run-prefix>
/subagents steer|follow-up|stop <run-prefix>
/subagents retry|resume|reconcile|abandon <run-prefix>
/subagents release-workspace <run-prefix>
/subagents export-output <run-prefix> <destination>
/subagents export-handoff <run-prefix> <destination>
/subagents pin|unpin <run-prefix>
/subagents prune [--apply]
```

The package also ships the `subagents` operating skill
(`skills/subagents/SKILL.md`), declared through `pi.skills`, which tells a
calling model what the `subagent` tool accepts, how workspace isolation is
inferred, and what a worktree handoff requires from a human.

The project does not provide backwards compatibility. Public contracts and
persisted formats may change incompatibly; consumers must use the exact supported
contract revision. The current contract revision is 8.

## Agent definitions

Named agents are Markdown files with strict YAML frontmatter in
`<getAgentDir()>/agents/*.md` or, for trusted projects, `<cwd>/.pi/agents/*.md`.
The file name must match `name`. Every declared value is a ceiling that a launch
request may narrow but never widen:

```yaml
---
name: reviewer
model:
  provider: github-copilot
  id: gpt-5.6-luna
  thinking: low
allowedModels: [github-copilot/gpt-5.6-luna:low]
tools: [read, grep]
preloadSkills: []
contextScopes: [project]
workspaceModes: [read-only]
memoryBytes: 2147483648
limits:
  cumulativeRuntimeMs: 600000
  attemptTimeoutMs: 300000
  totalTokens: 1000000
  cost: 10
  outputBytes: 1048576
  workspaceWriteBytes: 0
  retries: 1
  resumes: 1
---
Agent prompt.
```

`memoryBytes` is optional and bounds the attempt VM's memory. It defaults to
512 MiB, must be a positive integer multiple of 64 MiB, and may not exceed
4 GiB; a request above the agent ceiling fails preflight. Raise it for
memory-hungry guest toolchains such as a full-repository `tsc --noEmit`. Guest
vCPU count is fixed at one. Host memory exposure is the VM capacity slot count
(4) times the per-run grant.

Guest package-manager caches are redirected outside the workspace
(`XDG_CACHE_HOME=/tmp/cache`), so they never consume `workspaceWriteBytes` and
never appear in a handoff patch. When a writing attempt does exhaust
`workspaceWriteBytes`, guest writes fail with `EDQUOT` and the attempt records
the `workspace-budget` failure code.

## Ceilings

Two ceilings bound a launch, and a launch may only narrow them.

The **agent definition's allowance** is the first: every frontmatter value above
is a maximum, and a request that asks for a tool, model, workspace mode, limit,
or memory grant the definition does not declare fails preflight.

The **host ceiling** is the second. A host whose own mode restricts what it may
do (a read-only review mode, say) must be able to bound what it delegates, or
delegation becomes a way around the mode. `SubagentRequest.ceiling` states that
bound in this runtime's vocabulary — workspace modes and tool names, never the
host's own mode names — and the effective allowance is the agent's allowance
intersected with it. An absent `ceiling`, or an absent sub-field, is no bound on
that axis. The compiled launch plan records the ceiling it applied.

Because the model-facing `subagent` tool builds its own requests, a host
registers the ceiling once instead of injecting a field:

```ts
import { registerDelegationCeilingProvider } from "@vegardx/pi-subagent/ceiling-provider";

const unregister = registerDelegationCeilingProvider(pi.events, () => ({
	workspaceModes: ["read-only"],
	tools: ["read", "grep", "find", "ls"],
}));
```

The tool consults the provider at every launch. Exactly one provider may be
registered; a second registration is refused. A refusal names the bound it hit:

```text
workspace mode exceeds host ceiling: worktree (host allows read-only)
tool exceeds host ceiling: write
```

## Package

The npm package ships compiled ESM and declarations:

```ts
import { createSubagentService } from "@vegardx/pi-subagent";
import piSubagentExtension from "@vegardx/pi-subagent/extension";
import { acquireSubagentService } from "@vegardx/pi-subagent/service-provider";
import { registerDelegationCeilingProvider } from "@vegardx/pi-subagent/ceiling-provider";
```

The extension registers its lazy service provider on Pi's process-local event
bus. On first service acquisition it discovers named agents from
`<getAgentDir()>/agents/*.md` and, for trusted projects,
`<cwd>/.pi/agents/*.md`; project definitions override equal global names.
Trusted peer extensions can acquire that exact service instance through the
provider export. A consumer that ships its own agent definitions names their
absolute directories in `SubagentRequest.agentRoots`; those definitions resolve
under `package` scope ahead of discovery, so a definition's own templates always
win and a project or global agent of the same name cannot shadow one. With no consumer loaded, registration does not initialize
Gondolin or alter standalone subagent behavior.

Pi loads the declared extension from `dist/extension.js`. The supported release
line requires Pi `>=0.85.0 <0.86`, Node.js 23.6 or newer, and macOS Apple Silicon
with the qualified Gondolin/QEMU stack.

## Documentation

- [Glossary](docs/glossary.md)
- [Architecture](docs/architecture.md)
- [Contracts](docs/contracts.md)
- [Authority model](docs/authority.md)
- [Persistence and recovery](docs/persistence.md)
- [Failure taxonomy](docs/failures.md)
- [Threat model](docs/threat-model.md)
- [Acceptance inventory](docs/acceptance.md)
- [Implementation research](docs/research.md)
- [Research source ledger](docs/research-sources.md)
- [Implementation plan](docs/implementation-plan.md)
- [macOS arm64 Gondolin qualification](docs/qualification/gondolin-darwin-arm64.md)
- [Roadmap](docs/roadmap.md)

## Relationship to pi-workflow

[`pi-workflow`](https://github.com/vegardx/pi-workflow) consumes the registered
`SubagentService` through the typed service-provider export. It checks the exact
runtime contract before starting work and never creates, replaces, or shuts down
the physical execution service. Revision 7 adds the `vmMemoryCeiling` and
`workspaceBudgetRefusal` features and the `workspace-budget` failure code; a
consumer pinned to revision 6 must move to 7, because persisted state and the
feature set are not backwards compatible.

## License

MIT
