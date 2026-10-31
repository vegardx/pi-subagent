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
- VM memory is a per-agent ceiling, not a global constant: an agent definition
  declares it and a launch request may only narrow it.

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

Arbitrary Pi extensions are not child resources. Loading extension code in the
host seat grants host authority before child tool allowlisting, so only the
exact pi-web provider contract is currently adapted. Its `search` and `fetch`
declarations are recomputed, deep-frozen, persisted in launch identity, bounded
again by pi-subagent, and invoked with attempt cancellation plus a host timeout.
API keys remain inside the trusted pi-web service. Listing an extension path is
not a sufficient grant.

## Resource defaults

| Resource | Default |
| --- | --- |
| Extensions | None |
| Skill catalog | Normal global/package skills plus trusted-project skills |
| Preloaded skill instructions | None unless named by agent/request |
| Prompt templates | None |
| Context files | Explicit `global`/`project` scopes; project requires trust; synthetic read-only `/context` projection |
| Built-in tools | Explicit allowlist |
| Recursive subagent tool | Denied |
| Workspace | Read-only |
| VM memory | 1 GiB; agent ceiling 1 GiB to 4 GiB in 64 MiB steps; a request may only narrow it, never below 1 GiB |
| VM CPUs | 1; not configurable per agent |
| Concurrent VMs | `maxSlots` per host across every seat, default 16, at most 32; operator setting only |
| Guest storage | Per-VM copy-on-write root disk, 4 GiB virtual, on host temporary storage, deleted at VM close; no scratch tmpfs |
| Package-manager caches | `/var/cache/pi-subagent` through `XDG_CACHE_HOME`, on the root disk; never inside `/workspace` |
| Network | Public internet; internal ranges blocked |
| Repository-local files | Visible, including `.env` and similar files |
| Host credentials and home | Not mounted |

Guest shell environments are reconstructed rather than copied. Only bounded
locale/terminal variables are accepted from Pi; guest `HOME` and `TMPDIR` are
fixed to `/workspace` and `/tmp`. Host `PATH`, tokens, provider variables, proxy
configuration, and arbitrary extension environment are denied.

Every VM-backed process tool also receives fixed cache locations outside the
workspace: `XDG_CACHE_HOME=/var/cache/pi-subagent`,
`npm_config_cache=/var/cache/pi-subagent/npm`,
`YARN_CACHE_FOLDER=/var/cache/pi-subagent/yarn`,
`PNPM_STORE_DIR=/var/cache/pi-subagent/pnpm`, and
`PIP_CACHE_DIR=/var/cache/pi-subagent/pip`. `HOME` stays `/workspace` because
guest tooling expects a writable home, but a package cache under `HOME` would
otherwise consume `workspaceWriteBytes` and land in the handoff patch. The
cache lives on the attempt's copy-on-write root disk: its bytes are charged to
the guest-disk grant (`guestDiskBytes`), not to guest memory and not to the
workspace budget, and they never reach the host checkout. The root disk is a
qcow2 overlay Gondolin creates per VM in the host's temporary directory and
deletes when the VM closes. Earlier releases described a memory-backed rootfs:
Gondolin's `memory` rootfs mode on QEMU is a host-side write cache, and the
guest memory pressure came from its default scratch tmpfs mounts (`/tmp` and
others), which this runtime now disables.

## Filesystem policy

Host-owned Git commands run with a minimal environment, fixed non-secret commit
identity, global/system config disabled, commit signing disabled, filesystem
monitoring disabled, and hooks redirected to `/dev/null`. This prevents handoff
commits from executing project hook code with host authority. Git metadata
creation and release remain fenced runtime effects, not model-selected commands.

The VM receives `/workspace` and only explicitly declared auxiliary mounts.
Host home, Pi configuration, provider authentication, runtime state, and
unrelated repositories are absent.

Dependency directories are taken off the workspace mount. Before any tool
runs, the root `node_modules` and each npm `workspaces` member's `node_modules`
(literal or single-segment `*` patterns; `**` and negations are skipped) are
bind-mounted in the guest onto `/var/lib/pi-subagent/deps/<digest>` on the
attempt's root disk. A directory is bound only when the workspace's own Git
reports it ignored (`git check-ignore`), so binding never changes what reaches
a handoff: the handoff is a Git commit and ignored paths were never in it.
Symlinked, non-directory, and unignored candidates are skipped, and the sandbox
record lists every bound and skipped path with its reason. The host creates an
absent mountpoint, empty, only in a checkout it owns (a worktree or a
read-only snapshot); in the operator's live checkout an absent directory is
skipped. Consequence: what the guest installs into a bound directory lives on
the root disk and never reaches the host, and a bound directory hides the host
directory's existing contents from the guest. A bind that fails fails the
start as `sandbox-launch`.

Read-only attempts receive a `ReadonlyProvider`. Writing attempts receive a
`RealFSProvider` rooted at a private worktree and wrapped in the
`workspaceWriteBytes` budget. A write past the budget is refused with `EDQUOT`
(Disk quota exceeded) rather than a generic I/O error, so a guest process can
tell budget exhaustion from disk failure. Repository-local files are not
filtered merely because they may contain secrets. Canonicalization and provider
containment must prevent traversal and symlink escape beyond the selected root.

The host owns Git branch/worktree operations and authoritative handoff capture.
The VM does not receive unrestricted access to the repository's common Git dir.
A workspace that must start from earlier work names that hand-off commit as
`startAt`; the host checks the attempt's worktree out at it (or, read-only,
mounts a detached host checkout of it) and squashes the final tree into one
commit on the baseline HEAD. A resume with `continueFromHandoff` checks a new
worktree out at the run's own latest hand-off instead, keeps that hand-off's
baseline, and refuses a hand-off of another run or one whose baseline is no
longer HEAD. The resume message enters the restored session as an ordinary user
message: it grants nothing, and the resumed attempt runs under the plan it was
compiled with. The guest never applies a hand-off and is not expected to have
`git`.

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
