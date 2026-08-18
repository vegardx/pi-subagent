# AGENTS.md

`pi-subagent` is a native Pi subagent runtime. Keep the repository independent
from pi-workflow and pi-maestro policy.

## Current phase

The repository is documentation-first. Do not implement runtime behavior until
the glossary, contracts, state transitions, authority model, and acceptance
criteria are explicit.

## Design rules

- Pi public APIs are the platform boundary. Do not import private `dist/*`
  modules.
- A logical run, physical attempt, process identity, session, and workspace are
  distinct identities.
- Ambient child extensions are disabled by default. Explicit grants may narrow
  authority but never widen an agent definition's ceiling.
- A requested worktree or sandbox must fail closed; never silently fall back to
  shared execution.
- PID alone is not process identity. Do not report cleanup without evidence.
- Persist state before external side effects and make recovery conservative.
- Keep model-facing tools and the internal service on one implementation.
- Do not add workflow scheduling, plan compilation, publication, or PR policy.

## Engineering

- TypeScript strict mode, tabs, double quotes, Biome defaults.
- Test observable behavior and failure transitions.
- Keep public contracts versioned and backwards compatibility explicit.
- Use Conventional Commits.
