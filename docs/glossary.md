# Glossary

This document owns subagent terminology. Downstream projects should link to
these definitions rather than redefine them.

| Term | Definition |
| --- | --- |
| Pi seat | The interactive parent Pi process occupied by the user. It owns active native sessions and VMs. |
| Agent definition | Declarative role configuration: prompt, model route, tools, forced skill preloads, context, and authority ceiling. |
| Agent session | One Pi model conversation with independent messages, context, model, tools, and lifecycle. |
| Parent agent | The session delegating work. Usually the seat or a workflow host. |
| Subagent | An agent session created to execute one bounded delegated task. |
| Native subagent | A subagent created in the seat through Pi's public `createAgentSession()` SDK. |
| Delegation | Creation of a subagent run from a self-contained task contract. |
| Owner | Principal authorized to inspect and control a run, such as a parent Pi session or workflow run. |
| Operation ID | Caller-chosen idempotency key for one mutating service request. |
| Run | One logical delegated task across zero or more attempts. |
| Attempt | One physical execution of a run. Retry and resume create new attempts. |
| Backend | The mechanism executing an attempt. The canonical backend is a native `AgentSession` with one Gondolin VM. |
| Session ID | Pi identity of the child conversation. It is not a run or attempt ID. |
| Sandbox ID | Runtime identity of one attempt's Gondolin VM and immutable policy. |
| VM identity | Evidence identifying one Gondolin/QEMU VM instance. A PID alone is insufficient. |
| Steering | Additional input delivered while an active child turn is running. Receipt does not imply model compliance. |
| Follow-up | Input delivered to the active session after its current turn settles. |
| Cancellation | Caller-requested termination of a run. |
| Interruption | Loss of active execution, including seat exit, that may retain a resumable Pi session and workspace. |
| Control receipt | Acknowledgement that an active session accepted, missed, or rejected a control operation. It is not a detached queue. |
| Agent settled | Pi has no pending retry, compaction retry, tool continuation, steering, or follow-up for the attempt. |
| Workspace | Filesystem root exposed at `/workspace` inside the VM. |
| Read-only workspace | The caller's selected checkout exposed without write authority. |
| Worktree workspace | A private host-created Git worktree exposed read-write to one attempt. |
| Sandbox | The Gondolin VM boundary confining guest filesystem and process effects. A worktree is not a sandbox. |
| Public-egress policy | Guest public internet access with host, private, link-local, metadata, and internal ranges blocked. It is not an exfiltration boundary. |
| Tool allowlist | Concrete tools callable in one child session. |
| Tool declaration | Single registry entry binding a tool's schema, grant, implementation, authority, and acceptance coverage. |
| Capability | Stable semantic permission mapped to concrete tools and resources. |
| Authority ceiling | Maximum capabilities an agent definition permits. Calls may narrow but not widen it. |
| Resource projection | Immutable resolution of tools, normal skill catalog, forced skill preloads, scoped context files, fork transcript, and prompts granted to an attempt. |
| Context scope | Explicit `global` or trusted `project` selection of Pi context files, separate from transcript fork mode. |
| Ambient resource | Resource discovered from normal global or project configuration. |
| Explicit resource | Resource deliberately granted in an attempt's launch plan. |
| Retention pin | Owner-scoped durable protection for a run's complete linked persistence graph. |
| Recoverable trash | Timestamped sibling storage receiving pruned state by rename; ordinary pruning never hard-deletes run data. |
| Artifact | Durable bounded output associated with a run or attempt. |
| Handoff | Host-captured commit or artifact preserving worktree changes before cleanup. |
| Retry | New attempt with the same task after a classified failure. It gets a fresh VM. |
| Resume | New attempt continuing a retained Pi session after validation. It gets a fresh VM. |
| Seat lease | Cross-process claim allowing one seat instance to mutate a run, session, VM, or worktree. |
| Fencing generation | Monotonic value attached to state changes so a superseded seat cannot commit stale writes. |
| Reconcile | Compare persisted state with seat, session, VM, workspace, and handoff reality and classify drift. |
| Cleanup blocked | Terminal state where required VM or workspace cleanup cannot be proved. |
| Terminal state | State from which the runtime will not continue automatically. |
| Contract revision | Exact public and persisted format identity. Revisions are not backwards-compatible. |
