# pi-subagent

Native subagent runtime for [Pi](https://pi.dev).

This repository is in the contract-definition phase. It does not yet ship a
working extension.

## Goal

Provide one reusable implementation for delegated Pi agents:

- explicit model, tool, extension, skill, and context grants;
- isolated child Pi sessions with a canonical RPC subprocess backend;
- foreground and durable background runs;
- steering, follow-up, cancellation, retry, resume, and reconciliation;
- worktree and sandbox policies that fail closed;
- bounded artifacts, usage accounting, and process-cleanup evidence;
- a typed service used by both the model-facing tool and workflow engines.

`pi-subagent` owns physical agent execution. It does not schedule workflow
stages or define delivery policy.

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
