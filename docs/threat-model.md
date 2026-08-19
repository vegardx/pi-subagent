# Threat model

## Primary goal

The sandbox protects the host from accidental destructive model-driven actions.
The representative failures are commands such as:

```text
rm -rf ~
find / -type f -delete
chmod -R ... outside the repository
kill host processes
write to another checkout
connect to a local database or cloud metadata service
```

Model-driven filesystem and process effects run in one Gondolin VM assigned to
one attempt. The guest receives only its selected repository/worktree mount, so
an accidental broad path or process command cannot operate on the host home,
other repositories, Pi state, or host processes.

## Protected properties

- Guest writes cannot escape the selected workspace mount.
- Read-only attempts cannot mutate the selected checkout.
- Writing attempts cannot mutate the active checkout or another attempt's
  worktree.
- Guest processes cannot signal or manipulate host processes.
- Guest network traffic cannot reach localhost, private networks, link-local
  services, or cloud metadata endpoints.
- VM shutdown is proved before an attempt reports successful cleanup.
- VM memory, runtime, concurrency, guest-disk growth, workspace writes, and
  captured output have enforceable bounds or fail qualification.
- Worktree handoff is captured before destructive cleanup.
- State never claims unobserved launch, completion, shutdown, handoff, or
  cleanup.

## Explicit non-goals

The initial runtime does not claim to prevent:

- reading files intentionally present in the selected repository/worktree;
- transmitting repository content or repository-local secrets to the public
  internet;
- a deliberately malicious model probing the permitted workspace or public
  network;
- a malicious trusted Pi extension or same-account host process;
- QEMU, Gondolin, or guest-kernel escapes;
- side channels;
- hostile denial-of-service behavior beyond the qualified hard limits.

Repository-local `.env`, `.npmrc`, key, and credential files are visible when
present. Host home, Pi configuration, and provider credential stores remain
unmounted because they are unnecessary, not because confidentiality against an
active attacker is the primary boundary.

## Trust boundaries

| Boundary | Assumption |
| --- | --- |
| Pi, pi-subagent, and Gondolin host library | Trusted code with user authority |
| QEMU and qualified guest image | Trusted isolation foundation |
| User-global agent definitions | Trusted configuration |
| Project agents/resources | Untrusted until Pi project trust |
| Model output, fetched content, guest commands | Error-prone and potentially destructive |
| Gondolin guest | Must be contained to declared host resources |
| Other same-UID host process | Outside the boundary |
| Arbitrary installed Pi extension | Trusted host code; outside owner-client isolation |

## Filesystem boundary

Only the selected repository or private worktree is mounted at `/workspace`.
The active checkout is read-only for non-writing attempts. Writing attempts use
a private worktree so even destructive commands affect recoverable isolated Git
state rather than the user's active checkout.

A `RealFSProvider` intentionally grants access beneath its root. Mount
construction, path canonicalization, symlink containment, and read-only wrapping
are therefore security-critical. The Pi agent directory, host home, runtime
store, unrelated repositories, and unrestricted common Git metadata are not
mounted.

The sandbox does not prevent an agent from deleting every file in its own
private worktree. That is acceptable: the host baseline and handoff lifecycle
must make the damage reviewable and recoverable.

## Process boundary

Guest shell commands and subprocesses execute in the VM. Model-facing built-in
tools must route through Gondolin-backed operations. A mutating host-backed tool
would bypass the primary safety property and is not allowed.

Host-owned lifecycle and Git operations are narrowly implemented runtime code,
not model-selected shell commands. Read-only host adapters may be added only
when their lack of mutation is mechanically constrained and tested.

## Network boundary

Guest commands may access the public internet. Gondolin mediates DNS and
connections and blocks localhost, private, link-local, metadata, and other
internal address ranges, including after resolution and redirects.

This prevents common accidental interaction with host and local infrastructure.
It is not an exfiltration boundary. Per-agent hostname allowlists and dynamic
approval are intentionally out of scope.

## Lifecycle and denial of service

One VM belongs to one active attempt and closes on completion, cancellation,
seat exit, or reload. Before creation it holds one OS-owned capacity slot backed
by a deterministic localhost TCP listener. Socket binding is atomic across seat
processes and the OS releases it on owner death; occupied unrelated ports reduce
capacity rather than widening it. Gondolin's internal-range policy prevents the
guest from connecting to lease listeners. A separate fenced cross-process lease
prevents another seat from mutating the same run or worktree. The runtime records host-process and QEMU
identity; a replacement seat cannot resume or reuse the worktree until the prior
writer and VM are proved terminal. Active work does not survive loss of its
seat.

Timeouts and output bounds are not enough if a guest can exhaust host storage or
memory first. Qualification must prove configured VM memory and concurrency
bounds and a hard bound for guest-overlay and workspace growth. It must also
measure CPU, process, cancellation, and shutdown behavior. If Gondolin's VFS or
image backend cannot enforce storage bounds, the production adapter needs a
quota wrapper or the backend fails qualification.

## Worktrees are not sandboxes

A worktree protects Git state but does not isolate host filesystem, processes,
or network. Gondolin supplies the execution boundary; the worktree supplies a
recoverable mutation and handoff boundary. Writing attempts require both and
fail before model execution if either cannot be established.
