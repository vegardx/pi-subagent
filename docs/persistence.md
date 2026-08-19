# Persistence and recovery

## Implementation status

The current store primitive implements private run directories, bounded
sequenced JSONL events, fsync-backed appends, atomic snapshots, exact contract
revision validation, JSON-roundtrip validation, and repair of one unterminated
tail. Interior corruption fails closed. The operation index atomically binds an
owner-scoped operation ID to one request digest and run through create-once hard
links; identical replay adopts the mapping and conflicting replay fails.
Cross-process run leases now use OS-owned per-run localhost listeners and
monotonic durable generations. Fenced journals and worktree lifecycle mutations
verify the current lease before side effects and receipts. Session-specific leases and deep external-side-effect reconciliation remain
incomplete; run and retention leases cover current destructive ownership. Current reconciliation reacquires run fencing, compares the recorded QEMU PID,
process start time, and full command digest, and signals only an exact stale
identity. PID reuse, malformed evidence, or a non-QEMU command remains unknown
and is never signalled. Retained sessions are accepted only when their canonical
path is inside the session root and `SessionManager` identity matches the durable
`session-started` receipt. Worktrees are classified from canonical path, Git
root, branch, HEAD, status, handoff/baseline commit, release receipt, and retained
branch evidence before conservative failed/interrupted/cleanup-blocked outcomes
are persisted. Immutable run
records persist owner and launch identity before execution. Startup scans them,
restores proved terminal snapshots and artifact access, skips runs held by a
live seat, and classifies unproved stale execution as cleanup-blocked. Artifact
blobs are content-addressed, privately stored, bounded per artifact and store,
deduplicated, and rehashed on export. Retention now uses explicit owner pins, a
cross-process lease, per-run fencing, dry-run reports, age and byte-budget
selection, and recoverable trash.

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
seats and seat replacement. Global VM capacity uses OS-owned localhost listener
slots; per-slot JSON records are diagnostics, not authority. The OS releases a
listener on process death, so capacity does not depend on heartbeat expiry or
stale-file deletion. These mechanisms do not provide detached execution. There
is no external supervisor, detached control channel, or live VM adoption.

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
terminated only when PID, start time, qualified QEMU command, and command digest
match the durable startup receipt; identity is rechecked before escalation from
SIGTERM to SIGKILL. Otherwise cleanup remains blocked
for operator action. Retry, resume, or release cannot acquire the worktree while
the prior VM or seat writer remains live or its terminal state is unproved.

Unprovable state becomes explicit `unknown` or `cleanup-blocked`, never success.

## Workspaces and handoff

A read-only checkout has no workspace mutation to retain. A writing attempt's
worktree and reservation record remain host-owned across seat restart. Handoff
stages every change, creates an immutable commit, and persists that commit before
cleanup. Cleanup refuses dirty worktrees or any path, branch, or HEAD mismatch.

Cancellation or interruption preserves uncaptured writes unless cleanup policy
can prove there are none. Explicit `release` removes a retained worktree only
after durable handoff or explicit discard confirmation.

## Retention

The ordinary retention policy is:

```text
active/queued/stopping:            indefinite
interrupted/cleanup-blocked:       indefinite
dirty or otherwise retained tree:  indefinite
explicit owner pins:               indefinite
ordinary terminal age:             30 days
ordinary retained-data budget:     2 GiB
```

`completed`, `failed`, and `cancelled` runs are ordinary terminal runs. Runs
older than 30 days are selected first. If younger ordinary runs still exceed the
2 GiB budget, the oldest are selected until the budget is met. Protected bytes
are reported separately and never evicted to make the ordinary budget appear
satisfied.

A run pin protects the full graph: run and attempt records, journal and snapshot,
artifacts, sessions, operation mappings, lease record, and released worktree
metadata. Worktree records gain a durable `releasedAt` receipt only after both
the verified worktree and branch are gone; any unreleased or uncertain worktree
protects its run.

Retention mutation holds one cross-process OS-owned lease and acquires each
selected run lease before moving data. A live run lease converts selection into
a protected result rather than signaling or deleting the run. Dry-run is the
default. Applied pruning writes and fsyncs a manifest, then renames linked state
into a timestamped sibling trash directory. It never hard-deletes run data.
Pin removal is also recoverable through trash.

Operators use `/subagent-prune` for a report and `/subagent-prune --apply` after
confirmation. The run record moves last as the graph commit marker and a durable
completion receipt distinguishes finished trash moves from recoverable partial
intents. `/subagent-pin <run-id> [reason]` and `/subagent-unpin <run-id>`
manage pins owned by the current Pi session.
