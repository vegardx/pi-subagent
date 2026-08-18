# Glossary

This document owns subagent terminology. Downstream projects should link to
these definitions rather than redefine them.

| Term | Definition |
| --- | --- |
| Pi seat | The interactive parent Pi process occupied by the user. |
| Agent definition | Declarative role configuration: prompt, model route, tools, skills, extensions, context, and authority ceiling. |
| Agent session | One Pi model conversation with independent messages, context, model, tools, and lifecycle. |
| Parent agent | The session delegating work. Usually the seat or a workflow host. |
| Subagent | An agent session created to execute one bounded delegated task. |
| Native subagent | A subagent created through Pi's public SDK or RPC interfaces by this extension. It may run in another Pi process. |
| Delegation | Creation of a subagent run from a self-contained task contract. |
| Owner | Principal authorized to inspect and control a run, such as a parent Pi session or workflow run. |
| Operation ID | Caller-chosen idempotency key for one mutating service request. |
| Run | One logical delegated task across zero or more attempts. |
| Attempt | One physical execution of a run. Retry and resume create new attempts. |
| Backend | The mechanism executing an attempt. The canonical backend is a child Pi RPC process. |
| Session ID | Pi identity of the child conversation. It is not a run or attempt ID. |
| Process identity | Evidence identifying one OS process instance. A PID alone is insufficient because PIDs are reused. |
| Steering | Additional input delivered while a child is active. Delivery is acknowledged separately from model compliance. |
| Follow-up | Input queued for delivery after the current child turn settles. |
| Cancellation | Caller-requested termination of a run. |
| Interruption | Non-successful loss of execution that may retain a resumable session. |
| Control receipt | Durable acknowledgement of a steering, follow-up, or stop operation. |
| Agent settled | Pi has no pending retry, compaction retry, tool continuation, steering, or follow-up for the current attempt. |
| Workspace | Filesystem root in which an attempt operates. |
| Shared workspace | The caller's existing checkout. |
| Worktree workspace | A separate Git worktree allocated to an attempt. |
| Sandbox | An OS-enforced execution boundary. A worktree is not a sandbox. |
| Tool allowlist | Concrete tools callable in one child session. |
| Tool provider | Extension or SDK implementation that registers a tool. |
| Capability | Stable semantic permission mapped to concrete tools and resources. |
| Authority ceiling | Maximum capabilities an agent definition permits. Calls may narrow but not widen it. |
| Resource projection | Immutable resolution of tools, extensions, skills, context, and prompts granted to an attempt. |
| Ambient resource | Resource discovered from normal global or project configuration. |
| Explicit resource | Resource deliberately granted in an attempt's launch plan. |
| Artifact | Durable bounded output associated with a run or attempt. |
| Retry | New attempt with the same logical task contract after a classified failure. |
| Resume | New attempt continuing a retained child session after validation. |
| Lease | Time-bounded claim granting one owner permission to mutate a run or session. |
| Fencing token | Monotonic generation attached to writes so a superseded owner cannot commit state. |
| Reconcile | Compare persisted state with external process/session/workspace reality and classify drift. |
| Cleanup blocked | Terminal state where required process or workspace cleanup cannot be proved. |
| Terminal state | State from which the runtime will not continue automatically. |
