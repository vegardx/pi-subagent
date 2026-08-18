# Acceptance inventory

This inventory defines evidence required before stable releases.

## Launch and resources

- clean one-shot RPC child reaches `agent_settled`;
- ambient extensions are absent;
- explicit extension provider and exact tools are present;
- resource changes between preflight and release are rejected;
- project agent/resource loading follows Pi trust;
- custom provider model and authentication work without credential persistence.

## Idempotency and lifecycle

- duplicate caller operation ID creates one run;
- crash after child start but before caller receipt is recoverable by operation ID;
- retry creates a new attempt under the same run;
- resume validates and exclusively leases the retained session;
- foreground and detached startup receipts have documented durability points;
- run-wide limits survive retry/resume.

## Control

- steering and follow-up are ordered and deduplicated;
- acknowledgements distinguish persistence from session acceptance;
- terminal children return `missed`, not false delivery;
- stop races with launch and completion have one winner;
- inactive owner results are retained and delivered once.

## Processes

- PID reuse/birth mismatch prevents signaling;
- TERM-resistant child and descendant escalate to KILL and are proved gone;
- unknown process identity becomes cleanup-blocked;
- parent crash leaves enough state for conservative reconciliation.

## Workspaces

- requested worktree fails outside Git and never falls back;
- parallel writers receive distinct worktrees;
- patch/commit handoff is captured before cleanup;
- uncertain worktree is retained;
- cleanup failure blocks successful terminal status;
- sandbox denial is never retried without sandbox.

## Persistence and security

- torn journal tail, corrupt snapshot, future schema, and stale lease fail closed;
- fencing rejects writes from a superseded supervisor;
- sensitive fields are redacted and files use private modes;
- child workspace cannot reach supervisor state under the sandboxed profile;
- retention never deletes active or cleanup-blocked runs.

## Distribution

- packed package loads in a fresh `PI_CODING_AGENT_DIR`;
- tool and command ownership has no collisions;
- public runtime contract matches implementation;
- supported Pi version range is tested explicitly.
