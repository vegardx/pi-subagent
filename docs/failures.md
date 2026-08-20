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
| Sandbox launch | VM boot or agent handshake failed | Bounded when classified transient |
| Mount policy | Path containment, VFS construction, or read-only enforcement failed | Never; re-preflight after correction |
| Network policy | Destination denied or policy could not be enforced | Never without a new grant |
| Provider transient | Rate limit or temporary model transport failure | Bounded with backoff |
| Model output | Structured-output noncompliance | Bounded repair, then fail |
| Tool | Guest tool failed; fatal command timeout closed the VM | Manual only after inspecting partial effects |
| Timeout | Attempt or settlement deadline | New attempt only by policy |
| Cancellation | Caller stop won before completion | Never |
| Seat interruption | Seat exited or reloaded during an active attempt | Explicit validated resume |
| Lease loss | Seat lost fenced ownership of run/session/worktree | Abort local work; reconcile before retry |
| Sandbox cleanup | VM closure or QEMU identity cannot be proved | Reconcile; cleanup blocked |
| Workspace | Worktree preparation, handoff, or cleanup failed | Preparation may retry; cleanup fails closed |
| Persistence | Journal, receipt, or fsync failure | Fail closed before authority release |
| Resource drift | Agent, skill, context, image, or policy changed after preflight | Re-preflight; never continue old plan |
| Unknown | Unclassified error or unprovable external state | Reconcile/operator action |

A retry creates a new attempt under the same logical run. `manual` permits only
an explicit operator retry. `backoff` additionally enforces
`min(300s, retryAfterMs × 2^attemptOrdinal)` from the durable terminal event.
`never`, `resume`, and `reconcile` cannot enter the retry path. Resume is reserved
for a validated persisted Pi session whose failure disposition is `resume`.
Both operations create a fresh Gondolin VM. Neither operation erases prior
evidence, reuses live guest state, or resets run-wide budgets.

`runtimeMs` is a cumulative run-wide budget alongside uncached input/output
tokens, cost, retry count, and resume count. Cache read/write tokens are reported
but do not consume the ceiling. `attemptRuntimeMs` is the per-attempt deadline and may not
exceed the remaining run-wide runtime. Every terminal attempt records measured
wall-clock milliseconds, including startup and cleanup. Retry or resume subtracts
that duration, clamps the next attempt deadline to the remaining runtime, and
fails before execution when fewer than 1,000 milliseconds remain. Resume records
the retained session's message count and accumulated usage before prompting, then
accounts and returns only assistant output, usage, and cost added by the new
attempt; prior session usage is not charged twice.

Each attempt queues convergence steering once at 70% and urgent finalization
steering once at 90% when either cumulative uncached token usage, cumulative run
runtime, or that attempt's wall-clock runtime reaches the threshold. The stage is
persisted before steering is queued. A fresh retry or resume attempt receives its
own reminders against the remaining budgets. Steering and its advisory receipt
are best-effort and never turn otherwise successful task work into a failure;
a missing receipt permits the reminder to be sent again.

A filesystem escape or denied host/internal-network destination is a boundary
result, not a transient infrastructure failure. The runtime must not retry it
with weaker policy.
