# Persistence and recovery

## Storage

Authoritative supervisor state lives outside child workspaces:

```text
<getAgentDir()>/subagents/projects/<project-id>/runs/<run-id>/
  run.json
  events.jsonl
  attempts/<attempt-id>/
  artifacts/
  control/
  workspace.json
```

A bounded pointer index lives under:

```text
<getAgentDir()>/subagents/run-index.json
```

Directories are mode `0700`; sensitive files are mode `0600`. Prompts, logs,
context, artifacts, and results are bounded. Credential-shaped metadata is
redacted, while unavoidable source-derived secrets are treated as sensitive
artifact content with explicit retention.

## Journal

Lifecycle events are append-only and versioned. `run.json` is a bounded snapshot
that can be rebuilt from events plus external reconciliation.

External side effects follow:

```text
acquire fenced lease/authority
→ persist intent with fencing token
→ perform side effect with the same token
→ persist receipt with the same token
```

State must never claim that a process stopped, a worktree was removed, or input
was delivered without corresponding evidence.

## Single-writer ownership

Each run has a lease with owner identity, monotonic fencing token, and
heartbeat. Every state write and external command carries the current fencing
token. Reclamation requires process/owner evidence in addition to heartbeat
expiry; a stale clock observation alone is insufficient. Process and session
leases are separate with documented lock ordering.

Events carry schema version, sequence number, event ID, timestamp, owner, and
fencing token. Appends and snapshots use crash-safe write/fsync/rename rules.
Recovery ignores one provably torn tail record, rejects interior corruption,
and isolates unknown future event versions.

## Resume

Resume creates a new attempt. Before launch it validates:

- original run ownership and terminal/interrupted state;
- retained session existence and identity;
- cwd and workspace identity;
- agent definition and authority ceiling;
- model/tool/resource contract;
- remaining limits;
- absence of another live session writer.

Stopped runs and runs in `cleanup-blocked` are not automatically resumable.

## Reconciliation

Reconciliation compares records with:

- process birth identity and process-group membership;
- session file and lease state;
- control-channel acknowledgements;
- workspace/worktree existence and cleanliness;
- terminal result and cleanup receipts.

Unprovable state becomes explicit `unknown` or `cleanup-blocked`, never success.

## Retention

Artifacts and terminal runs have bounded retention. Active, interrupted,
cleanup-blocked, and retained-worktree records are never removed by ordinary
retention cleanup.
