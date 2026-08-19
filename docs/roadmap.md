# Roadmap

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
- seat-exit interruption and conservative reconciliation.

## Phase 4 — product surface

- steering and follow-up while the seat is active;
- bounded widget and inspector;
- packed-package smoke tests;
- real QEMU acceptance on macOS and Linux;
- exact contract revision check for workflow consumers;
- first stable API.

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
