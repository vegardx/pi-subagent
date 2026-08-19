# Gondolin qualification — macOS arm64

Date: 2026-08-19

## Environment

| Component | Version |
| --- | --- |
| macOS architecture | arm64 |
| Node.js | 24.16.0 |
| Pi | 0.84.2 |
| Gondolin | 0.12.0 |
| QEMU | 11.1.0 |
| Model drive | `github-copilot/gpt-5.6-luna` |

The first Gondolin asset resolution populated approximately 326 MB under the
normal Gondolin cache.

## Result

Gondolin is suitable as the tool-effect isolation backend on this platform,
subject to a project-owned cross-process VM capacity manager. This is a
qualification result, not production acceptance.

| Check | Result | Evidence |
| --- | --- | --- |
| Read-only workspace | Pass | `ReadonlyProvider` rejected a guest write and the host fixture was unchanged. |
| Seven Pi built-in tools | Pass | `read`, `write`, `edit`, `bash`, `grep`, `find`, and `ls` executed through Gondolin operations. |
| Repository-local files | Pass | A fixture `.env` remained visible inside `/workspace`. |
| Destructive write confinement | Pass | Recursive deletion emptied only the mounted disposable workspace; its sibling sentinel remained unchanged. |
| Host-path confinement | Pass | Host Pi configuration and the host parent of the workspace were unavailable in the guest. |
| Public HTTPS | Pass | Guest `curl` reached `https://example.com`. |
| Host/internal network denial | Pass | Loopback and `169.254.169.254` requests failed with internal-range blocking enabled. |
| Workspace write budget | Pass | A project wrapper stopped a 1 MiB write at the configured 131,072-byte cumulative limit. |
| Concurrent VM isolation | Pass | Two VMs wrote distinct markers to distinct host mounts without observing each other. |
| Native Pi sessions | Pass | Two concurrent in-process `AgentSession`s used separate VMs and returned exact markers. |
| Ambient resource isolation | Pass | Both native sessions loaded zero extensions, skills, prompts, themes, and context files. |
| VM shutdown | Pass | Every recorded QEMU PID was absent after `vm.close()`; no Gondolin/QEMU runner remained after the drive. |
| Global cross-process VM limit | Blocked | Gondolin configures one VM but does not coordinate capacity between Pi seat processes. pi-subagent must own this layer. |

The final drive completed five executable checks with no failures and one
blocked runtime-layer requirement. Warm QEMU boots were approximately 0.45–0.75
seconds at 512 MB and one vCPU. Two concurrent native model sessions completed
in approximately 5.3 seconds.

## Important behavior

`VM.create()` resolves assets and constructs the controller, but measurements
must call `vm.start()` explicitly before recording boot completion or host PID.
Relying on the first filesystem or exec operation to trigger lazy startup gives
misleading timing and identity evidence.

Aborting a Gondolin `vm.exec()` rejects the host-side promise but does not by
itself guarantee termination of the guest process. Attempt cancellation must
close the whole per-attempt VM and prove its QEMU process terminal. It must not
reuse the VM after an aborted command.

`RealFSProvider` has no built-in workspace quota. The spike wraps it with
`SandboxVfsProvider` and reserves a cumulative byte budget before each write,
write-file, or truncate operation. This safely limits host write amplification,
but the production wrapper still needs adversarial coverage for every VFS
mutation path and concurrent handles.

The spike's recursive `grep` and `find` operations are adapted from Pi's official
Gondolin example. They prove VM routing, not complete local-tool parity. They do
not yet implement the full ignore behavior and need cycle-safe, bounded traversal
before becoming production tools.

Gondolin's memory and CPU options constrain each QEMU instance, but global
capacity is outside Gondolin. Production launch authority needs a
cross-process, crash-recoverable capacity lease before creating a VM.

## Remaining qualification

- Linux/KVM execution and cleanup evidence;
- cross-process global VM-capacity lease and stale-owner recovery;
- adversarial write-budget tests for truncate, append, concurrent handles,
  rename, links, and failed writes;
- CPU-loop, fork-loop, guest-root-disk, and host-pressure measurements;
- private Git worktree mount and handoff behavior;
- persisted Pi session resume into a fresh VM;
- abrupt seat termination and stale QEMU reconciliation.

The spike must not be presented as evidence for these unexecuted behaviors.

## Reproduction

```bash
npm install
npm run check
npm run qualify:gondolin
```

Raw run reports and disposable fixtures are written under ignored `.pi/`
directories. The committed qualification code is under `spike/gondolin/`.
