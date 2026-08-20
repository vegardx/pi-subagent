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
- read-only checkout access for readers and private worktrees for writers;
- host-owned models, credentials, Git handoffs, persistence, and cleanup;
- cancellation, classified failure, backoff, fresh-VM retry/resume, and reconciliation;
- cumulative runtime/uncached-token/cost budgets, 70%/90% convergence steering,
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
actions, search/filtering, current/all-project scope, retention preview, and an
attention-only widget. During an active parent turn, `Alt+S` opens the inspector
without submitting editor input; steer/follow-up appear only after the child
session reports control readiness. Direct commands use the same service
authority:

```text
/subagents list [--all]
/subagents show|status <run-prefix>
/subagents logs|wait <run-prefix>
/subagents steer|follow-up|stop <run-prefix>
/subagents retry|resume|reconcile|release <run-prefix>
/subagents pin|unpin <run-prefix>
/subagents prune [--apply]
```

The project does not provide backwards compatibility. Public contracts and
persisted formats may change incompatibly; consumers must use the exact supported
contract revision.

## Package

The npm package ships compiled ESM and declarations:

```ts
import { createSubagentService } from "@vegardx/pi-subagent";
import piSubagentExtension from "@vegardx/pi-subagent/extension";
```

Pi loads the declared extension from `dist/extension.js`. The supported release
line requires Pi `>=0.84.2 <0.85`, Node.js 23.6 or newer, and macOS Apple Silicon
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

[`pi-workflow`](https://github.com/vegardx/pi-workflow) will consume the typed
`SubagentService` only after pi-subagent is finished and release-qualified.
Workflow implementation and integration are intentionally deferred until then;
workflow must never create a private second subagent runtime.

## License

MIT
