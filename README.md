# pi-subagent

Native subagent runtime for [Pi](https://pi.dev).

This repository is in the contract-definition and qualification phase. It does
not yet ship a working extension.

## Goal

Provide one reusable implementation for delegated Pi agents:

- native in-process Pi `AgentSession`s with explicit resource projection;
- one Gondolin Linux micro-VM per active attempt;
- VM-backed built-in tools with fail-closed host-write containment;
- read-only checkout access for readers and private worktrees for writers;
- host-owned models, credentials, Git handoffs, persistence, and cleanup;
- cancellation, retry, fresh-VM resume, and reconciliation;
- bounded artifacts and usage accounting;
- a typed service used by both the model-facing tool and workflow engines.

Active attempts stop when the Pi seat exits or reloads. Their session and
workspace state persist for explicit resume in a fresh VM. The initial runtime
does not provide detached execution or survival across seat exit.

`pi-subagent` owns physical agent execution. It does not schedule workflow
stages or define delivery policy.

The project does not provide backwards compatibility. Public contracts and
persisted formats may change incompatibly; consumers must use the exact supported
contract revision.

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
- [Roadmap](docs/roadmap.md)

## Relationship to pi-workflow

[`pi-workflow`](https://github.com/vegardx/pi-workflow) consumes the typed
`SubagentService`; it must not create a private second subagent runtime.

## License

MIT
