# Persistence and recovery

## Storage

Authoritative host state lives outside every mounted workspace:

```text
<getAgentDir()>/subagents/projects/<project-id>/runs/<run-id>/
  run.json
  events.jsonl
  sessions/<attempt-id>.jsonl
  attempts/<attempt-id>/
    launch.json
    sandbox.json
    result.json
  artifacts/
  workspace.json
```

A bounded pointer index lives under:

```text
<getAgentDir()>/subagents/run-index.json
```

Directories are mode `0700`; sensitive files are mode `0600`. Prompts, logs,
context, artifacts, and results are bounded. Credential-shaped metadata is
redacted. The store is never mounted into Gondolin.

## Journal

Lifecycle events are append-only and versioned. `run.json` is a bounded snapshot
that can be rebuilt from events plus external reconciliation.

External side effects follow:

```text
persist intent
→ perform side effect
→ persist receipt and observed identity
```

State must never claim that a VM started or stopped, a session settled, a
worktree was removed, or a handoff was captured without corresponding evidence.

Events carry schema version, sequence number, event ID, timestamp, owner, and
attempt identity. Appends and snapshots use crash-safe write/fsync/rename rules.
Recovery ignores one provably torn tail record and rejects interior corruption
or an unknown contract revision. Persisted-state compatibility and migrations
are not supported; incompatible state receives explicit discard guidance.

## Cross-seat ownership

One seat instance owns an active attempt. A private cross-process lease records
the seat identity, host process birth identity, monotonic fencing generation,
and bounded heartbeat. Every run event, session mutation, worktree mutation,
and terminal receipt carries the accepted generation. A second seat cannot
launch, resume, reconcile destructively, or release the same run while the lease
holder is live.

Heartbeat expiry alone does not grant authority. Reclamation validates the host
process identity and reconciles any recorded QEMU VM before issuing a higher
fencing generation. A stale writer cannot commit state after replacement. Run,
session, worktree, and global VM-capacity locks use documented ordering.

Operation indexes and leases make duplicate launch idempotent across concurrent
seats and seat replacement. They do not provide detached execution. There is no
external supervisor, detached control channel, or live VM adoption.

## Seat shutdown

The owning seat holds all active native sessions and VMs for its attempts.

On graceful seat exit or reload the extension:

1. marks active attempts as stopping;
2. aborts their `AgentSession`s;
3. closes their Gondolin VMs;
4. records VM cleanup evidence;
5. retains session and workspace state;
6. marks resumable work as interrupted.

After an ungraceful exit, the next seat treats persisted `active`, `running`, or
`settling` attempts as interrupted until reconciliation proves VM and workspace
state. It never reports completion from stale state.

## Resume

Resume creates a new attempt and a fresh Gondolin VM. It does not restore guest
RAM, guest processes, sockets, or a previous VM controller.

Before launch it validates:

- original run ownership and interrupted state;
- retained Pi session existence and identity;
- agent definition and authority ceiling;
- model, tools, skills, and context projection;
- workspace/worktree and baseline identity;
- Gondolin package and image compatibility;
- mount and public-egress policy;
- remaining runtime, token, cost, retry, and resume limits;
- absence of another active writer for the session or worktree.

A changed policy requires new preflight authority. Cleanup-blocked runs are not
automatically resumable.

## Reconciliation

Reconciliation compares records with:

- Pi session files;
- QEMU process identity when one was recorded;
- Gondolin terminal/close receipts;
- worktree existence and baseline identity;
- handoff commits and artifact digests;
- terminal result and cleanup receipts.

An apparently live stale QEMU process is never adopted into a new session. It is
terminated only after identity validation; otherwise cleanup remains blocked
for operator action. Retry, resume, or release cannot acquire the worktree while
the prior VM or seat writer remains live or its terminal state is unproved.

Unprovable state becomes explicit `unknown` or `cleanup-blocked`, never success.

## Workspaces and handoff

A read-only checkout has no workspace mutation to retain. A writing attempt's
worktree remains host-owned across seat restart. Completion records an immutable
commit or artifact handoff before removal.

Cancellation or interruption preserves uncaptured writes unless cleanup policy
can prove there are none. Explicit `release` removes a retained worktree only
after durable handoff or explicit discard confirmation.

## Retention

Artifacts and terminal runs have bounded retention. Active, interrupted,
cleanup-blocked, and retained-worktree records are never removed by ordinary
retention cleanup.
