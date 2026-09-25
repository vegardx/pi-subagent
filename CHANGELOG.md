# Changelog

This file starts at 0.14.0. Earlier releases are recorded in the git history.

The project keeps no backwards compatibility: an incompatible public contract or
persisted format fails explicitly instead of migrating. Persisted state written
at an earlier contract revision is quarantined, not read.

## 0.14.0

### Added

- A host may bound one delegation with `SubagentRequest.ceiling`, stated in this
  runtime's own vocabulary: `workspaceModes` and `tools`. The launch's effective
  allowance is the agent definition's declared allowance intersected with the
  ceiling, and an absent field or sub-field is no bound on that axis. Preflight
  refuses by name with `workspace mode exceeds host ceiling: worktree (host
  allows read-only)` or `tool exceeds host ceiling: write`.
- The compiled `AgentLaunchPlan` records the ceiling it applied, sorted, so the
  bound is part of the launch identity digest and of the persisted run and
  attempt records.
- `registerDelegationCeilingProvider` in the new
  `@vegardx/pi-subagent/ceiling-provider` entry point. The model-facing
  `subagent` tool builds its own requests, so a host registers one provider on
  Pi's process-local event bus and the tool consults it at every launch. Exactly
  one provider may be registered; a second registration is refused. No provider
  is no bound, and an answer that violates the contract fails the launch rather
  than widening it.
- Runtime contract feature `delegationCeiling: true`.

### Changed

- Contract revision 7 becomes 8: the persisted launch plan carries the recorded
  ceiling. Revision 7 state is quarantined on store open, and a consumer pinning
  revision 7 must move to 8.
- The `subagent` tool's description tells the model that the host may bound a
  delegation and that a refusal names the bound it hit.
