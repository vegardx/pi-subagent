# Implementation research

The design is informed by source inspection of Pi and existing isolation and
subagent implementations. Concept adoption does not imply compatibility or
source copying. Pinned identities are recorded in the
[research source ledger](research-sources.md).

## Isolation comparison

| Implementation | Agent execution | Isolation provided | Relevant finding |
| --- | --- | --- | --- |
| Pi Gondolin example | Native seat session | Built-in tool operations run in a Linux VM | Best fit for keeping models/auth in the seat while containing destructive tool effects |
| Gondolin | QEMU Linux VM | Explicit VFS mounts and host-mediated networking | Strong, understandable host-write/process boundary; heavier than OS policy sandboxes |
| Pi sandbox example | Current Pi session | Overrides `bash` with Anthropic SRT | Other built-ins remain host-backed unless replaced too |
| `@erichll/pi-sandbox` | Process-backed subagents | Per-command/session SRT brokers | Strongest inspected SRT integration; still process-oriented for complete child isolation |
| `@agwab/pi-subagent` | Child Pi process | Wraps child launch with SRT | Sandboxes the full child but duplicates Pi runtime and requires child resource/auth design |
| tintinweb/pi-subagents | Native `AgentSession` | Resource loader filtering and optional worktrees | Good context/resource isolation, but no OS boundary for tool effects |
| pi-subagentura | Process-backed | Child/process lifecycle patterns | Does not change the selected native-session plus VM direction |

## Selected model

Use one native Pi `AgentSession` and one Gondolin VM per attempt.

Adopt from Pi and Gondolin:

- `createAgentSession()` and `SessionManager` for child conversations;
- `DefaultResourceLoader` with ambient resources disabled;
- built-in Pi tool factories with replacement operation implementations;
- `/workspace` as the guest-visible cwd;
- Gondolin VFS providers for explicit host mounts;
- Gondolin host-mediated public networking with internal ranges blocked;
- model providers and authentication kept in the host seat.

The official Pi Gondolin example proves the integration shape but is not the
complete policy. Production code additionally needs one-VM-per-attempt
ownership, worktree management, cancellation proof, persistence, resume, and
acceptance tests.

## Threat-model consequence

The primary requirement is accidental destructive-action containment, not
confidentiality against an actively malicious agent.

Therefore:

- the selected repository/worktree is visible as normal repository content,
  including `.env` and similar local files;
- public internet access is allowed;
- localhost, private networks, link-local services, and metadata endpoints are
  blocked;
- host home, Pi state, credentials, and unrelated repositories remain unmounted
  because the agent does not need them;
- mutating model-facing tools must run in Gondolin;
- writing agents use private worktrees so destruction is recoverable and does
  not affect the active checkout.

This does not claim to prevent repository-data exfiltration.

## Why not the alternatives

### Child Pi under Anthropic SRT

This can sandbox the complete runtime and arbitrary extension code. It also
introduces one Pi process per child, duplicated runtime configuration,
provider/resource projection across a process boundary, platform-specific SRT
backends, and more complex detached supervision. Those costs are not needed for
the selected accidental-tool-effect boundary.

### Native session without an OS boundary

Resource-loader filtering prevents ambient prompts, skills, and extensions, but
host-backed `bash`, `write`, or `edit` can still damage the host. A worktree
protects Git state only. This does not satisfy the primary requirement.

### Shared or pooled VM

Pooling reduces startup cost but allows agents to interfere through shared
process and filesystem state and complicates attribution and cleanup. Begin with
one VM per attempt and reconsider only after measured evidence.

## Gondolin constraints to qualify

- Node.js 23.6 or newer;
- QEMU and first-use guest asset download;
- Alpine guest image and package availability;
- no full RAM/process-state snapshots;
- network protocol limitations, including no generic UDP/QUIC/WebRTC;
- QEMU escape, side channels, and complete denial-of-service prevention remain
  non-goals;
- the experimental `krun` backend is not part of the initial target.

The current qualification candidate is Gondolin 0.12.0 on QEMU 11.1.0. The
accepted package and image identities are pinned only after the spike passes.

## Rejected defaults

- ambient child extensions;
- host-backed mutating tools;
- prompt-only filesystem confinement;
- treating a worktree as a sandbox;
- silent sandbox or worktree fallback;
- sharing one VM between agents;
- mounting host home or the Pi agent directory;
- detached execution in the initial runtime;
- claims of exfiltration prevention;
- backwards-compatibility shims or persisted-state migrations.

## Source adaptation

Before copying a substantial implementation:

1. record repository, commit, file, and license;
2. decide whether to reimplement a concept or adapt source;
3. retain required notices for copied or substantial portions;
4. port relevant tests before changing behavior;
5. document intentional divergence.
