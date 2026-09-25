# Roadmap

Phases 0–4 are implemented and release-qualified on the supported macOS Apple
Silicon host. The standalone 0.9 candidate is active in the maintainer's normal
Pi configuration alongside pi-maestro, which no longer bundles a subagent
extension. No package-path filter is required. Phase 5 consumer integration
remains intentionally blocked until the stable-version decision; the
pi-subagent-side prerequisite for it, handoff export, ships ahead of that gate
because it is a service capability of this repository and not workflow code.

## Phase 0 — contracts

- glossary and ownership boundary;
- run, attempt, session, VM, and workspace identities;
- accidental-damage threat model;
- authority and resource projection;
- state transitions and failure taxonomy;
- persistence and acceptance inventory;
- explicit no-backwards-compatibility policy.

## Phase 1 — Gondolin qualification

- QEMU and image capability probe;
- disposable `/workspace` VFS mount;
- Pi tool operations routed through Gondolin;
- host-write and process containment tests;
- read-only enforcement;
- public internet with host/internal-range blocking;
- concurrent one-VM-per-agent test;
- cancellation and shutdown proof;
- startup, memory, disk, and cleanup measurements.

## Phase 2 — native foreground service

- global and trusted-project agent discovery;
- self-contained delegation envelope;
- exact model and thinking selection;
- isolated `DefaultResourceLoader`;
- native `createAgentSession()` execution;
- immutable launch plan and idempotency;
- bounded output, usage, artifacts, status, logs, and wait;
- cancellation and terminal result.

## Phase 3 — workspaces and recovery

- read-only checkout mounts;
- fail-closed managed worktrees;
- host-owned commit/artifact handoff;
- retained uncertain work;
- retry and persisted-session resume into a fresh VM;
- fenced cross-seat ownership;
- seat-exit interruption and conservative reconciliation.

## Phase 4 — product surface

- steering and follow-up while the seat is active;
- explicit durable abandonment of interrupted runs after cleanup proof;
- exact host-brokered `search` and `fetch` tools from the shared pi-web service;
- service-owned action eligibility shared by inspector and direct commands;
- bounded widget and inspector with separate ongoing and needs-action status
  groups;
- packed-package smoke tests;
- real QEMU acceptance on macOS Apple Silicon;
- first stable API.

## Phase 5 — deferred workflow integration

Service-side prerequisite, delivered in this repository under contract
revision 6: `exportHandoff`, `HandoffRef`, durable handoff refs that survive
release, and retention cleanup of those refs, so a consumer can import writer
evidence as bounded digest-verified bytes without reading private branches or
host paths.

Contract revision 7 adds the per-agent VM memory ceiling (`vmMemoryCeiling`) and
the typed workspace write-budget refusal (`workspaceBudgetRefusal`). Contract
revision 8 adds the host delegation ceiling (`delegationCeiling`): a host bounds
a launch in workspace modes and tool names, and the compiled launch plan records
the ceiling it applied. A consumer that pins an earlier revision must move to 8;
there is no compatibility path.

Consumer integration starts only after pi-subagent completes full acceptance,
dogfood cutover, and stable release qualification:

- exact contract revision check for workflow consumers;
- public-service-only pi-workflow integration;
- no duplicate workflow-owned subagent runtime.

## Initial non-goals

- workflow scheduling;
- detached execution or survival across seat exit;
- recursive subagents;
- multiple execution backends;
- VM pooling or sharing;
- arbitrary child extension loading;
- per-agent network allowlists or exfiltration prevention;
- tmux/Zellij UI;
- generated extension wrappers;
- web source caching;
- publication or PR policy;
- backwards-compatible APIs or persisted-state migrations.
