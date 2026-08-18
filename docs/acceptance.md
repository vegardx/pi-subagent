# Acceptance inventory

This inventory defines evidence required before stable releases.

## Launch and resources

- clean one-shot RPC child reaches `agent_settled`;
- ambient extensions, skills, prompts, themes, and context files are absent;
- explicit extension provider and exact tools/resources are present;
- child attests effective model, thinking, cwd, session, tools, provider source
  identities, and prompt/resource projection;
- resource changes between preflight and release are rejected;
- project agent/resource loading follows Pi trust;
- custom provider model and authentication work without credential persistence.

## Idempotency and lifecycle

- concurrent duplicate caller operation ID creates one run;
- same operation ID with a different request identity fails;
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
- inactive-owner notifications are at least once with stable IDs; repeated
  delivery is harmless through consumer deduplication.

## Processes

- PID reuse/birth mismatch prevents signaling;
- TERM-resistant tracked child and descendants escalate to KILL and are proved
  gone within the tracked process-group boundary;
- a descendant escaping that boundary becomes cleanup-blocked unless a stronger
  sandbox boundary proves it gone;
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
- numerical output/log/event/artifact/control/runtime/retry/token/cost bounds
  produce documented truncation or terminal outcomes;
- child workspace cannot reach supervisor state under the sandboxed profile;
- retention never deletes active or cleanup-blocked runs.

## Distribution

- packed package loads in a fresh `PI_CODING_AGENT_DIR`;
- tool and command ownership has no collisions;
- public runtime contract matches implementation;
- real Pi structured output covers sole final-answer, sibling tool calls, schema
  rejection, repair exhaustion, and partial usage completeness;
- supported Pi version range is tested explicitly.
