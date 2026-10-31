# Changelog

This file starts at 0.14.0. Earlier releases are recorded in the git history.

The project keeps no backwards compatibility: an incompatible public contract or
persisted format fails explicitly instead of migrating. Persisted state written
at an earlier contract revision is quarantined, not read.

## 0.19.0

Contract revision 11. Revision 10 state is quarantined, not read: a revision 10
launch plan or agent definition may carry guest memory below the new floor.

### Changed

- Guest VM memory (`memoryBytes`) spans 1 GiB to 4 GiB in 64 MiB steps and
  defaults to 1 GiB, for the `subagent` tool, service requests, and agent
  definitions. A 64 MiB Gondolin guest never reached readiness because its
  in-memory rootfs does not fit. A request below the floor fails preflight with
  the schema's reason; a definition below it is refused as invalid frontmatter,
  naming the violation. `MIN_MEMORY_BYTES` is exported;
  `MEMORY_GRANULARITY_BYTES` is only the step.
- The attempt deadline (`attemptTimeoutMs`) no longer runs while the VM boots;
  boot is bounded by the 60 s guest-readiness timeout. A boot that outlasts
  `attemptTimeoutMs` fails as `sandbox-launch`, not `timeout`. `runtimeMs`
  stays wall-clock, so boot is still charged to `cumulativeRuntimeMs`.

### Fixed

- A guest that does not become ready fails with `sandbox startup failed: guest
  did not become ready within <timeout> s at <memory>`, built from the launch's
  own bounds. Other start failures still read `sandbox startup failed`; the
  underlying exception's text is never persisted.

## 0.18.0

Contract revision 10, unchanged: no persisted record changes shape.

### Added

- `resume(runId, { continueFromHandoff: true, message })` continues the session
  of a `completed`, `failed`, or `cancelled` worktree run in a fresh attempt
  whose worktree is checked out at the run's latest hand-off. `message`
  (non-blank, at most 64 KiB) is the restored session's next user message. The
  attempt consumes one `limits.resumes`, reruns the plan's recorded model, and
  appends a `resume-at-handoff` journal event. Refused by name for a run that is
  not a worktree run, a run in another status, a run without a hand-off, a bad
  message, and spent resumes. Feature flag: `resumeAtHandoff`.
- `ResumeInput` and `MAX_RESUME_MESSAGE_BYTES` are exported.

### Changed

- The run's hand-off is its latest one. A resumed attempt squashes onto the
  original baseline, so its hand-off carries both changes and `exportHandoff`
  names the resumed attempt; one that changes nothing leaves the earlier
  hand-off as the run's, live and after restart.
- A run that carries a hand-off refuses `retry`, which would start over without
  it, and no longer reports itself retryable.

## 0.17.0

Contract revision 10. Revision 9 state is quarantined, not read.

### Added

- `workspace.startAt` names the hand-off commit a workspace starts at. Preflight
  refuses, by name, a commit the repository does not hold, one no
  `refs/pi-subagent/handoffs/<run-id>/<attempt-id>` ref points at, and one whose
  sole parent is not HEAD. The launch plan and run record carry it, so retry and
  resume start at the same commit. Feature flag: `workspaceStartAt`.
- A worktree with `startAt` is checked out at that commit. A read-only attempt
  with `startAt` mounts a detached host checkout of it, removed once the VM is
  closed; reconciliation removes one a crash left behind.
- Every guest file tool call (`read`, `write`, `edit`, `ls`, `find`, `grep`) is
  bounded at 300 s (`TOOL_CALL_DEADLINE_MS`) and returns an error result naming
  the bound when it expires; `find`, `ls`, and `grep` rooted at `/` are refused
  by name. `bash` is unchanged: only its own `timeout` and the attempt deadline
  bound it.

### Changed

- Hand-off capture squashes: one commit whose tree is the worktree's final tree
  and whose parent is the baseline HEAD, whatever commit the worktree started
  at. Without `startAt` the commit is the same as before.

## 0.16.0

### Changed

- Pi peers (`pi-coding-agent`, `pi-ai`, `pi-tui`, `pi-agent-core`) move from
  `>=0.85.0 <0.86` to `>=1.4.0 <2`; a host on Pi 0.x must stay on 0.15.0.
- `@earendil-works/pi-server` is no longer a peer: Pi removed it in 1.2.0 and
  nothing here imported it.

### Fixed

- Fork-context preflight works on Pi 1.4: `convertToLlm` moved from
  `pi-agent-core` to `pi-coding-agent`, and the old import left every
  `contextMode: "fork"` request failing.
- A brokered web tool result with `isError: true` reaches the child as an
  error. Pi honours the flag since 0.99 and the result was rebuilt without it;
  `terminate` is still dropped.
- A steer or follow-up that a session input handler consumes before it reaches
  the agent yields a `failed` receipt instead of `accepted-by-session`.

## 0.15.0

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
