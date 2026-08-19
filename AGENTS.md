# AGENTS.md

`pi-subagent` is a native Pi subagent runtime. Keep the repository independent
from pi-workflow and pi-maestro policy.

## Contract discipline

- Treat the glossary and public contracts as the source of truth for terminology
  and ownership.
- Update contracts, state transitions, authority rules, and acceptance coverage
  when behavior changes.
- Do not claim behavior that is not implemented and validated.

## Design rules

- Pi public APIs are the platform boundary. Do not import private `dist/*`
  modules.
- A logical run, physical attempt, VM identity, session, and workspace are
  distinct identities.
- Ambient child extensions are disabled by default. Explicit grants may narrow
  authority but never widen an agent definition's ceiling.
- A requested worktree or sandbox must fail closed; never silently fall back to
  shared or host execution.
- VM closure and workspace cleanup require evidence; do not infer either from a
  missing in-memory handle.
- Persist state before external side effects and make recovery conservative.
- Keep model-facing tools and the internal service on one implementation.
- Do not add workflow scheduling, plan compilation, publication, or PR policy.

## Engineering

- TypeScript strict mode, tabs, double quotes, Biome defaults.
- Test observable behavior and failure transitions.
- Do not preserve backwards compatibility. Incompatible public contracts,
  consumers, or persisted state must fail explicitly; do not add aliases,
  adapters, migration shims, or dual-format readers.
- Use Conventional Commits.
