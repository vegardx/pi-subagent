# Implementation research

The design is informed by source inspection of existing MIT implementations.
Concept adoption does not imply compatibility or source copying. Pinned source
identities are recorded in the [research source ledger](research-sources.md).

## Primary references

### `@agwab/pi-subagent`

Adopt as concepts:

- run/attempt separation;
- durable launch/cancel boundary;
- process birth identity;
- conservative interrupt and reconciliation;
- fail-loud worktree requests.

### `pi-subagents`

Adopt as concepts:

- immutable launch-time capability plan;
- independent ambient-extension disabling and explicit extension args;
- acknowledged file-backed control channel;
- session leases and validated resume descriptors;
- tracked process-group cleanup proof;
- durable background startup handshake;
- worktree handoff preservation;
- compact widget plus full inspector.

### `pi-crew`

Adopt the `goal`, `context`, and `instructions` delegation envelope and exact
owner-session result routing.

### Pi SDK

Use public `ModelRuntime`, `AgentSession`, `SessionManager`, the documented
classic RPC protocol, `DefaultResourceLoader`, tool factories, `SourceInfo`,
project trust, and `getAgentDir()`. Implement the RPC JSONL client directly
because the public `RpcClient` does not expose required spawn/process controls.

## Rejected defaults

- ambient extensions in children;
- prompt-only filesystem confinement;
- PID-only cleanup authority;
- silent worktree fallback;
- direct unversioned JSON state writes;
- process-local booleans as distributed locks;
- recursive delegation by default;
- returned error flags instead of throwing tool failures.

## Source adaptation

Before copying a substantial implementation:

1. record the source repository, commit, file, and license;
2. decide whether to reimplement a concept or adapt source;
3. retain MIT notices for copied or substantial portions;
4. port the source's relevant tests before changing behavior;
5. document intentional divergence.
