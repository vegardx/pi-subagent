# Architecture

## Boundary

`pi-subagent` owns delegated-agent execution. It does not own workflow graphs,
Maestro plans, publication, or repository-delivery policy.

```mermaid
graph TD
    Host[Pi extension or workflow host]
    Service[SubagentService]
    Store[Run store and journal]
    Backend[RPC child backend]
    Child[Child Pi process]
    Workspace[Workspace manager]
    Control[Control channel]

    Host --> Service
    Service --> Store
    Service --> Workspace
    Service --> Backend
    Backend --> Child
    Service <--> Control
    Control <--> Child
```

## Layers

1. **Extension adapter** registers the `subagent` tool, commands, and UI.
2. **Service** exposes the same runtime to trusted extension consumers.
3. **Policy compiler** resolves an immutable launch plan.
4. **Lifecycle runtime** owns runs, attempts, status, retry, and resume.
5. **Backend** owns child Pi startup, RPC, event collection, and settlement.
6. **Process supervisor** owns process identity, signals, and cleanup proof.
7. **Workspace manager** owns shared/worktree/sandbox preparation and handoff.
8. **Store** owns append-only events, bounded snapshots, artifacts, and leases in a supervisor root outside child workspaces.

No model-facing tool may bypass the service.

## Canonical backend

The first backend is a child Pi process in classic RPC mode. It provides context
and process isolation, active steering, cancellation, session control, and a
structured event stream.

Children start with ambient extensions disabled. The launch plan supplies only
the extension providers needed for granted tools:

```text
pi --mode rpc --no-extensions --extension <provider> ...
```

JSON mode may be supported for one-shot compatibility. In-process and tmux
backends are later additions and must preserve the same run/attempt contracts.

## Platform use

Use Pi rather than rebuilding:

- `getAgentDir()` and `CONFIG_DIR_NAME`;
- `ModelRuntime` and provider authentication;
- `AgentSession`, `SessionManager`, and RPC;
- built-in tool factories and tool schemas;
- project trust and resource provenance;
- extension lifecycle and UI APIs.

This repository owns what Pi does not provide: subagent supervision, process
trees, run persistence, worktrees, capability projection, and recovery.

## Dependency rule

`pi-workflow` depends on the public service contract. `pi-subagent` has no
runtime dependency on pi-workflow or pi-maestro.
