# Failure taxonomy

Every failure has a stable code, retryability classification, origin, and
operator guidance. Unknown failures are not silently treated as transient.

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
| Tool | Guest tool execution failed | Workflow/caller policy |
| Timeout | Attempt or settlement deadline | New attempt only by policy |
| Cancellation | Caller stop won before completion | Never |
| Seat interruption | Seat exited or reloaded during an active attempt | Explicit validated resume |
| Sandbox cleanup | VM closure or QEMU identity cannot be proved | Reconcile; cleanup blocked |
| Workspace | Worktree preparation, handoff, or cleanup failed | Preparation may retry; cleanup fails closed |
| Persistence | Journal, receipt, or fsync failure | Fail closed before authority release |
| Resource drift | Agent, skill, context, image, or policy changed after preflight | Re-preflight; never continue old plan |
| Unknown | Unclassified error or unprovable external state | Reconcile/operator action |

A retry creates a new attempt under the same logical run. Resume is reserved for
a validated persisted Pi session after seat interruption. Both create a fresh
Gondolin VM. Neither operation erases prior evidence, reuses live guest state, or
resets run-wide budgets.

A filesystem escape or denied host/internal-network destination is a boundary
result, not a transient infrastructure failure. The runtime must not retry it
with weaker policy.
