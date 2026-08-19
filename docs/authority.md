# Authority model

## Principles

- The runtime grants the least authority needed by one attempt.
- Agent definitions set ceilings; calls may only narrow them.
- Ambient child extensions and resources are absent by default.
- Every model-facing tool is implemented inside Gondolin or by a bounded,
  project-owned adapter represented in the launch identity.
- Project-controlled resources require Pi project trust.
- Worktrees isolate Git state, not operating-system access.
- Filesystem, process, and network policy are enforced below prompts.
- A requested boundary never silently degrades.
- VM count, memory, guest storage, workspace writes, runtime, and output are
  bounded below the prompt layer and across concurrent seat processes.

## Capability resolution

```text
agent definition ceiling
  ∩ caller grant
  ∩ native-session support
  ∩ Gondolin capability
  ∩ workspace policy
  ∩ public-egress policy
  ∩ project trust
  = effective launch plan
```

Unknown tools, adapters, resources, or sandbox capabilities fail before the
model session or VM starts.

## Tool authority

The initial built-in registry binds stable tool names to concrete
Gondolin-backed implementations:

```ts
interface ToolDeclaration {
	name: string;
	implementation: "gondolin-operation" | "bounded-host-adapter";
	classification: "read-only" | "write" | "process" | "network";
	workspaceModes: readonly ("read-only" | "worktree")[];
}
```

A declaration is the single source for model schema, grant validation, runtime
implementation, and acceptance coverage. The registry rejects drift at
construction.

Arbitrary Pi extensions are not child resources in the initial release.
Loading extension code in the host seat would grant host authority before tool
allowlisting. A future provider integration must be implemented through an
explicit adapter or run its code inside the VM; listing an extension path is not
a sufficient grant.

## Resource defaults

| Resource | Default |
| --- | --- |
| Extensions | None |
| Skill catalog | Normal global/package skills plus trusted-project skills |
| Preloaded skill instructions | None unless named by agent/request |
| Prompt templates | None |
| Context files | Explicit projection; project context requires trust |
| Built-in tools | Explicit allowlist |
| Recursive subagent tool | Denied |
| Workspace | Read-only |
| Network | Public internet; internal ranges blocked |
| Repository-local files | Visible, including `.env` and similar files |
| Host credentials and home | Not mounted |

## Filesystem policy

The VM receives `/workspace` and only explicitly declared auxiliary mounts.
Host home, Pi configuration, provider authentication, runtime state, and
unrelated repositories are absent.

Read-only attempts receive a `ReadonlyProvider`. Writing attempts receive a
`RealFSProvider` rooted at a private worktree. Repository-local files are not
filtered merely because they may contain secrets. Canonicalization and provider
containment must prevent traversal and symlink escape beyond the selected root.

The host owns Git branch/worktree operations and authoritative handoff capture.
The VM does not receive unrestricted access to the repository's common Git dir.

## Network policy

Guest commands may access public internet destinations. The effective
public-egress policy and its digest are part of preflight identity.

Gondolin must:

- mediate guest DNS and connections;
- block private, loopback, link-local, metadata, and other internal ranges;
- revalidate redirects and resolved addresses;
- expose bounded network audit events.

The initial release has no per-agent hostname allowlist or interactive approval.
This protects host and local-network services from accidental access; it does
not claim to prevent exfiltration.

## Credentials and repository-local secrets

Pi model credentials remain owned by the host `ModelRuntime`. Host credential
stores and home directories are not mounted because guest execution does not
need them.

Files inside the selected repository or worktree, including `.env`, `.npmrc`,
keys, or test credentials, are visible under that workspace's read/write mode.
Preventing their disclosure is not an initial security property. This accepted
risk must be explicit because public network egress means guest commands can
transmit repository content.

## Workspaces

A requested worktree is a contract. Failure to create or mount it fails the
attempt before model execution. There is no fallback to shared mutation.

Mutating attempts currently require a clean source repository at preflight and
receive separate worktrees. Read-only attempts may inspect dirty checkouts; their
baseline identity binds tracked diffs and untracked content. Work is captured as
an immutable commit or declared artifact before cleanup. Uncertain workspaces are
retained for diagnosis.
