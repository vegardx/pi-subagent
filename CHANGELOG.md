# Changelog

This file starts at 0.14.0. Earlier releases are recorded in the git history.

The project keeps no backwards compatibility: an incompatible public contract or
persisted format fails explicitly instead of migrating. Persisted state written
at an earlier contract revision is quarantined, not read.

## 0.21.0

Contract revision 13. Revision 12 state is quarantined, not read.

### Added

- `host` entry in an agent definition's `allowedModels`: an exact model the
  definition does not list exactly is admitted when the host's model-admission
  provider stands behind it, at any thinking level the host admits. An exact
  entry never consults the host; an inherited request still needs `inherit`.
  Refusals name the model:
  `model exceeds ceiling: <key> (template admits host, host does not admit it)`
  and
  `model exceeds ceiling: <key> (template admits host, no host model admission provider answered)`.
- `registerModelAdmissionProvider` and `resolveModelAdmission` in the new
  `@vegardx/pi-subagent/model-admission-provider` entry point
  (`ModelAdmissionProvider = (model: ExactModelRequest) => boolean`). Exactly
  one provider may be registered; a duplicate registration, two answers, or a
  non-boolean answer fail closed with `ModelAdmissionProviderError`.
- `modelAdmission` (`exact`, `inherit`, or `host`) in the launch plan and its
  identity digest: which fence entry admitted the plan's model.
- `hostModelAdmission` feature. `HOST_MODEL`, `ModelAdmissionSchema`,
  `ModelAdmission`, `HostModelAdmission`, and `MODEL_DEFAULT_REFUSAL` are
  exported.

### Changed

- An agent definition's `model` is optional when `allowedModels` lists
  `inherit` or `host`; without either, discovery refuses a definition with no
  `model`. A request that names no model against a definition without one is
  refused with
  `model required: definition names no default model; the request must name one`.
- `AgentDefinition.defaultModel` is optional, and `compileLaunchPlan` takes an
  optional `admitHostModel`.

## 0.20.0

Contract revision 12. Revision 11 state is quarantined, not read.

The first launch downloads the pinned guest image `alpine-base:0.4.0`
(about 330 MB) into the Gondolin image cache.

Upgrading: a host that ran 0.19 recorded `maxSlots: 4` in
`<agentDir>/subagents/capacity/policy.json`. With the new default of 16 every
seat refuses to run attempts, naming both values and that file, until either
`<agentDir>/subagents/settings.json` sets `"maxSlots": 4` or the policy file is
removed while no pi-subagent seat is running.

### Added

- `maxSlots` setting in `<agentDir>/subagents/settings.json`
  (`{ "maxSlots"?: integer 1..32 }`, no other keys), default 16 (was a fixed
  4). An invalid file refuses the extension load by path. The runtime contract
  reports it as `capacity.maxSlots`, so a host can cap its fan-out.
- `capacityWait` feature: an attempt whose host has no free VM slot waits for
  one, polling with backoff, up to `capacityWaitMs` (10 minutes, clamped to the
  run's remaining cumulative runtime). The wait stops when the attempt is
  cancelled and is not charged to `attemptTimeoutMs`; `runtimeMs` stays
  wall-clock.
- Failure code `capacity`, origin `service`, retry `backoff` with
  `retryAfterMs` 30 000, for an attempt that never got a slot. Its message is
  `VM capacity exhausted: <N> slots busy for <S> s`, built from the slot count
  and the measured wait.
- `createSubagentRuntimeContract`, `SUBAGENT_RUNTIME_FEATURES`,
  `readSubagentSettings`, `DEFAULT_MAX_SLOTS`, `MAX_SLOTS`, and
  `DEFAULT_CAPACITY_WAIT_MS` are exported. `registerSubagentServiceProvider`
  takes the contract to publish.

- Warm per-project checkpoints for npm projects: an attempt whose workspace has
  `package-lock.json` boots from a Gondolin disk checkpoint on which a
  model-free warm-up already ran `npm ci`, under
  `<agentDir>/subagents/checkpoints` (20 GiB, least recently used evicted,
  leased and in-progress keys kept). The sandbox record's `boot` states warm or
  cold, the warm-up outcome, the checkpoint key, and any warm-up failure code.
- Git-ignored `node_modules` directories (root and npm `workspaces` members)
  are bind-mounted onto the guest root disk before tools start; the sandbox
  record's `dependencies` lists bound and skipped paths with reasons.
- `sandbox.rootfsPolicySha256` in the launch grant.

### Changed

- Gondolin 0.14.0 (was 0.12.0), whose fs-rpc ordering closes a path-check race
  on `RealFSProvider` mounts and whose `VM.close()` is terminal. The guest image
  is pinned by ref to `alpine-base:0.4.0`: Gondolin's default selector resolves
  a locally cached `latest` that is never refreshed, which on an upgraded host
  is an older image. The grant's `packageVersion` comes from the installed
  package.
- Each attempt boots on a 4 GiB copy-on-write root disk (per-VM qcow2 overlay,
  deleted at close) with Gondolin's scratch tmpfs set disabled, so `/tmp` and
  `/var/cache` no longer spend guest memory. `guestDiskBytes` is that disk's
  size. The guest cache root moves from `/tmp/cache` to
  `/var/cache/pi-subagent`.
- The mount policy digest covers dependency binds (`GUEST_MOUNT_POLICY`).
- A read-only attempt on the operator's live checkout no longer sees the host's
  installed `node_modules`: an existing ignored `node_modules` is bound over in
  the guest and starts empty, or warm from a checkpoint. An absent one is not
  created in a live checkout and is left on the workspace mount.
- Docs no longer call the rootfs memory-backed or 1 GiB the boot floor: the
  pinned image boots at 96 MiB; 1 GiB stays as a workload floor.

### Fixed

- A full host refused attempts at once as `unknown`/`reconcile` with
  `usageComplete: false`, so a caller that treats incomplete usage as a refusal
  failed whole runs. Attempts now wait for a slot, and a refusal is typed.
- `usageComplete` is `true`, with zero usage, for any attempt that ended before
  its model session existed: a capacity refusal, a VM that failed to construct
  or start, or a refused model. Nothing ran, so nothing is missing.
- The capacity policy mismatch message names this seat's and the recorded
  `maxSlots` and `basePort` and the policy file.

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
