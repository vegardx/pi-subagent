# Failure taxonomy

Every non-completed terminal result has a bounded `ClassifiedFailure` with a
stable code, origin, retry disposition, message, and operator guidance. Unknown
failures are classified `unknown/reconcile`; they are never silently treated as
transient.

| Class | Examples | Default retry |
| --- | --- | --- |
| Validation | Invalid request, unknown tool, incompatible feature | Never |
| Trust | Untrusted project agent/resource | Never without new approval |
| Model resolution | Unknown or unavailable exact model | Never |
| Authentication | Missing or rejected provider credential | Never automatically |
| Sandbox capability | QEMU unavailable, image unsupported, Gondolin probe failed | Never without environment change |
| Capacity | Every VM slot stayed busy for the whole capacity wait | Backoff from 30 s |
| Sandbox launch | VM boot or agent handshake failed | Bounded when classified transient |
| Mount policy | Path containment, VFS construction, or read-only enforcement failed | Never; re-preflight after correction |
| Network policy | Destination denied or policy could not be enforced | Never without a new grant |
| Provider transient | Rate limit or temporary model transport failure | Bounded with backoff |
| Model output | Structured-output noncompliance | Bounded repair, then fail |
| Tool | Guest tool failed; fatal command timeout closed the VM | Manual only after inspecting partial effects |
| Timeout | Attempt or settlement deadline | New attempt only by policy |
| Cancellation | Caller stop won before completion | Never |
| Operator abandonment | Operator permanently gave up an interrupted run after cleanup proof | Never; terminal and prune-eligible |
| Seat interruption | Seat exited or reloaded during an active attempt | Explicit validated resume |
| Lease loss | Seat lost fenced ownership of run/session/worktree | Abort local work; reconcile before retry |
| Sandbox cleanup | VM closure or QEMU identity cannot be proved | Reconcile; cleanup blocked |
| Workspace | Worktree preparation, handoff, handoff ref, or cleanup failed | Preparation may retry; cleanup fails closed |
| Workspace budget | Guest writes exhausted `workspaceWriteBytes` and were refused with `EDQUOT` | Never; launch a new run with a larger budget or a smaller change |
| Persistence | Journal, receipt, or fsync failure | Fail closed before authority release |
| Resource drift | Agent, skill, context, image, or policy changed after preflight | Re-preflight; never continue old plan |
| Unknown | Unclassified error or unprovable external state | Reconcile/operator action |

A retry creates a new attempt under the same logical run. `manual` permits only
an explicit operator retry. `backoff` additionally enforces
`min(300s, retryAfterMs × 2^attemptOrdinal)` from the durable terminal event.
`never`, `resume`, and `reconcile` cannot enter the retry path. Resume is reserved
for a validated persisted Pi session whose failure disposition is `resume`, with
one exception: a resume with `continueFromHandoff` follows a completed, failed,
or cancelled worktree run that has a hand-off, whatever its failure disposition.
It refuses by name a run that is not a worktree run ("resume at hand-off
requires a worktree run"), one in another status ("resume at hand-off requires
a completed, failed, or cancelled run; run is <status>"), one without a
hand-off ("run has no exported hand-off to continue from"), a blank or
oversized message ("resume message must be non-blank and at most 65536
bytes"), and spent resumes ("resume budget exhausted"). A resumed attempt whose
final tree equals the baseline fails with the capture refusal "worktree
reverted the hand-off it started at; its final tree equals the baseline" and
leaves the earlier hand-off as the run's. A run that carries a hand-off refuses
retry ("retry would discard the run's hand-off; resume at the hand-off
instead"), because a retry starts over at the plan's start.
Both operations create a fresh Gondolin VM. Neither operation erases prior
evidence, reuses live guest state, or resets run-wide budgets. Abandonment is
not retry or cancellation: it removes recovery authority from an interrupted
run, records operator-origin `operator-abandoned` evidence, and preserves the
run graph until ordinary retention selects it.

`cumulativeRuntimeMs` is a run-wide budget alongside provider-reported dollar
cost, optional `totalTokens`, retry count, and resume count. A configured total
model-token guard consumes `Usage.totalTokens`, including cache traffic.
`attemptTimeoutMs` is the per-attempt deadline and may not exceed the
remaining cumulative runtime. It does not run while the attempt waits for a VM
slot or while its VM boots.

The wait for a slot has its own bound, `capacityWaitMs` (10 minutes by
default), clamped to the run's remaining cumulative runtime. Slots are short
leases, one per running attempt VM, so a full host is a queue: the attempt polls
for a free slot with backoff from 250 ms to 2 s and stops waiting at once when
it is cancelled. An attempt that never gets a slot fails as `capacity`, origin
`service`, retry `backoff` with `retryAfterMs` 30,000 ("VM capacity exhausted:
16 slots busy for 600 s", built from the slot count and the measured wait,
never from exception text). Nothing ran, so its zero usage is complete
(`usageComplete: true`) and its sandbox cleanup is `not-needed`.

Boot has its own bound, Gondolin's 60 s guest-readiness timeout, so a guest
that never becomes ready fails as `sandbox-launch` ("sandbox startup failed:
guest did not become ready within 60 s at 1024M", built from the launch's own
timeout and memory), never as `timeout`. Every other start failure reads
"sandbox startup failed"; the underlying exception's text is not persisted.
Every terminal attempt records measured wall-clock milliseconds, including
the capacity wait, boot, startup, and cleanup, so one attempt's `runtimeMs` may
exceed its `attemptTimeoutMs` by at most the capacity wait plus the boot bound
plus cleanup. Retry or resume subtracts that wall-clock duration, so waiting
and boot are charged to `cumulativeRuntimeMs`; it clamps the next attempt
deadline to the remaining runtime and fails before execution when fewer than
1,000 milliseconds remain. A run's wall-clock total can therefore overrun
`cumulativeRuntimeMs` by at most one boot bound plus cleanup (the wait is
already clamped to the remaining runtime), after which no further attempt is
admitted.

`usageComplete` is `false` only when a model session existed and the attempt
did not complete, because usage of an interrupted model turn may be partial.
An attempt that ended before its session was created (a capacity refusal, a
VM that failed to construct or start, a refused model) made no model call, so
its zero usage is complete. Resume records
the retained session's message count and accumulated usage before prompting, then
accounts and returns only assistant output, usage, and cost added by the new
attempt; prior session usage is not charged twice.

Each attempt queues convergence steering once at 70% and urgent finalization
steering once at 90% when either cumulative uncached token usage, cumulative run
runtime, or that attempt's runtime against `attemptTimeoutMs` (excluding boot)
reaches the threshold. The stage is
persisted before steering is queued. A fresh retry or resume attempt receives its
own reminders against the remaining budgets. Steering and its advisory receipt
are best-effort and never turn otherwise successful task work into a failure;
a missing receipt permits the reminder to be sent again.

A cleanup-blocked attempt keeps its run lease in the owning seat. Handoff
export, workspace release, and reconciliation reuse that held lease instead of
binding a second time, so same-seat operators are not refused with "run lease
unavailable"; the lease is released once the run leaves cleanup-blocked.

If release finds the handoff ref missing while the record carries a handoff
commit, release refuses, the reservation branch stays, and the run remains
cleanup-blocked and retained. The operator remedy is to restore the ref from the
recorded commit while the object still exists
(`git update-ref refs/pi-subagent/handoffs/<run-id>/<attempt-id> <handoffCommit>`
in the repository root), then release again; if the commit object is gone the
handoff cannot be exported and the run should be pinned for inspection or
abandoned through reconciliation rather than force-released.

`exportHandoff` is a read and never changes run state. It rejects with an
explicit error when the run is not owned, is not in a durable completed,
failed, cancelled, or cleanup-blocked state, has no handoff commit, exceeds the
requested or absolute byte bound, or when the handoff ref no longer resolves to
the recorded commit; the caller retries after correcting the request or pinning
the run, never by reading private repository state.

The `workspace-budget` code is distinct from `workspace`. The budgeted workspace
VFS refuses an over-budget write with Linux `EDQUOT` instead of the generic
`EIO` an untyped refusal would produce, the process tool appends one notice line
naming the limit, the reserved bytes, and the refusal count, and the attempt
records `workspace-budget` with workspace origin and retry `never`. A budget
refusal is a declared bound, not a disk failure and not a transient error: the
remedy is a new run with a larger `workspaceWriteBytes`, a smaller change, or
moving bulk output out of the workspace. Package-manager caches already live
under `XDG_CACHE_HOME` (`/var/cache/pi-subagent`, on the root disk), outside
the budget.

A filesystem escape or denied host/internal-network destination is a boundary
result, not a transient infrastructure failure. The runtime must not retry it
with weaker policy.
