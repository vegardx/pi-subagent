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

Gondolin is suitable as the tool-effect isolation backend on this platform.
pi-subagent supplies the cross-process VM capacity layer that Gondolin does not
provide. This is a qualification result, not production acceptance.

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
| Native Pi sessions | Pass | Two concurrent in-process `AgentSession`s passed exact catalog/thinking/auth preflight through `ModelRuntime`, used separate VMs, and returned exact markers. |
| Ambient resource isolation | Pass | Both native sessions loaded zero extensions, skills, prompts, themes, and context files. |
| VM shutdown | Pass | Every recorded QEMU PID was absent after `vm.close()`; no Gondolin/QEMU runner remained after the drive. |
| Global cross-process VM limit | Pass | A pi-subagent host-socket lease enforced capacity across worker processes and recovered automatically after a killed owner. |
| Production sandbox adapter | Pass | The promoted adapter acquired capacity, booted QEMU, mounted a budgeted workspace, routed a guest write, closed the VM, proved its PID released, and returned capacity. |
| Production native attempt runner | Pass | A validated launch plan drove exact model/auth resolution, a persistent native Pi session, isolated resources, VM-backed tools, fenced output artifacts, bounded inline results, journal/snapshot receipts, then reopened the session in a fresh VM and proved both cleanups. |
| Foreground `SubagentService` | Pass | Owner-bound preflight, concurrent duplicate launch adoption, status/log/wait observation, persistent operation identity, terminal startup recovery, schema-valid terminating structured output, JSON artifact export, and the production runner completed through the public service surface. |

The final drive completed nine executable checks with no failures or blocked
requirements. Warm QEMU boots were approximately 0.5–1.0 seconds at 512 MB and
one vCPU. Two concurrent native model sessions completed in approximately 4.9
seconds.

## Pi extension dogfood

The production extension was loaded as the only explicit extension in normal Pi
print mode with the `subagent` tool as the only parent tool. A real
`github-copilot/gpt-5.6-luna:low` parent delegated a read-only README task through
the public tool and received exactly:

```text
# pi-subagent
```

The child used the foreground service and Gondolin runtime, and no QEMU process
remained afterward.

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
capacity is outside Gondolin. pi-subagent now reserves deterministic localhost
TCP listeners as OS-owned capacity slots. Binding is atomic across seat
processes, the OS releases a slot on process death, unrelated port occupation
reduces capacity safely, and guest internal-network blocking prevents access to
the lease ports. An atomically installed policy file rejects seats configured
with a different slot count or port range. Per-slot JSON records are
observational rather than authoritative.

## Remaining qualification

- Linux/KVM execution and cleanup evidence;
- integration of the capacity lease into production VM launch authority;
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
