# Changelog

This file starts at 0.14.0. Earlier releases are recorded in the git history.

The project keeps no backwards compatibility: an incompatible public contract or
persisted format fails explicitly instead of migrating. Persisted state written
at an earlier contract revision is quarantined, not read.

## Unreleased

### Added

- A request's `model` may be the literal `inherit`: the launch runs on the model
  and thinking level the host session is using. pi-subagent cannot see the seat,
  so it resolves the answer at preflight through one provider the host
  registers - `registerSessionModelProvider` in the new
  `@vegardx/pi-subagent/session-model-provider` entry point. Exactly one
  provider may be registered; a second registration is refused. No provider, or
  a provider with no session model to give, refuses the request with `model
  inherit: no session model to inherit` rather than falling back to a pin the
  caller did not ask for, and an answer that violates the contract fails closed.
- An agent definition's `allowedModels` admits the entry `inherit`. A definition
  that lists it admits whatever the host session answers with, any model at any
  thinking level, so for an inherited model the fence lives at the host; one
  that does not refuses with `model exceeds ceiling: anthropic/opus-5:high
  (template admits github-copilot/gpt-5.6-luna:low, not inherit)`. Exact entries
  are unchanged.
- The compiled `AgentLaunchPlan` records `modelSource`: `request`, `template`, or
  `inherited`, so the persisted record says where the model came from. The plan
  never carries `inherit`; it carries the resolved exact model, and both fields
  are part of the launch identity digest. A retry or resume reruns the recorded
  model rather than resolving the session again.
- The `subagent` tool accepts `inherit` in its `model` parameter. It synthesizes
  its own definition, so it resolves the answer at the call and pins it; an
  explicit `thinking` still narrows the inherited level, and a call that names no
  model keeps using the seat's own current model.
- Runtime contract feature `sessionModelInherit: true`.

### Changed

- Contract revision 8 becomes 9: the persisted launch plan carries `modelSource`.
  Revision 8 state is quarantined on store open, and a consumer pinning
  revision 8 must move to 9.

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
