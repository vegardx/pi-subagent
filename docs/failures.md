# Failure taxonomy

Every failure has a stable code, retryability classification, origin, and
operator guidance. Unknown failures are not silently treated as transient.

| Class | Examples | Default retry |
| --- | --- | --- |
| Validation | Invalid request, unknown tool, incompatible feature | Never |
| Trust | Untrusted project agent/resource | Never without new approval |
| Model resolution | Unknown or unavailable exact model | Never |
| Authentication | Missing or rejected provider credential | Never automatically |
| Launch | Pi binary unavailable, RPC readiness timeout | Bounded when classified transient |
| Provider transient | Rate limit, temporary transport failure | Bounded with backoff |
| Model output | Structured-output noncompliance | Bounded repair, then fail |
| Tool | Tool execution failure | Workflow/caller policy |
| Timeout | Attempt or settlement deadline | New attempt only by policy |
| Cancellation | Caller stop won before completion | Never |
| Lease loss | Supervisor/session ownership lost | Reconcile first |
| Process drift | Birth identity or process group mismatch | Never signal; cleanup blocked |
| Workspace | Worktree/sandbox preparation or cleanup failed | Preparation may retry; cleanup fails closed |
| Persistence | Journal, receipt, or fsync failure | Fail closed before authority release |
| Resource drift | Agent/extension/skill/context changed after preflight | Re-preflight; never continue old plan |
| Unknown | Unclassified error or unprovable external state | Reconcile/operator action |

A retry creates a new attempt under the same logical run. Resume is reserved for
a validated retained session. Neither operation erases prior evidence or resets
run-wide budgets.
