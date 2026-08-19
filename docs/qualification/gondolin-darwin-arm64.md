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
| Production sandbox adapter | Pass | The promoted adapter acquired capacity, booted QEMU, mounted a budgeted workspace plus read-only skill and synthetic context namespaces, proved skill/context reads and write denial, routed a guest write, closed the VM, proved its PID released, and returned capacity. |
| Production native attempt runner | Pass | A validated launch plan drove exact model/auth resolution, a persistent native Pi session, isolated resources, VM-backed tools, fenced output artifacts, bounded inline results, journal/snapshot receipts, then reopened the session in a fresh VM and proved both cleanups. |
| Foreground `SubagentService` | Pass | Owner-bound preflight, normal trusted-project skill discovery, forced skill preload plus trusted-project context projection proofs in structured output, concurrent duplicate launch adoption, status/log/wait observation, terminal startup recovery, JSON artifact export, and the production runner completed through the public service surface. |

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

A second real CLI drive discovered a trusted project skill through normal Pi
skill discovery, forced it with `preloadSkills`, mounted its tree read-only in
the VM, and returned exactly:

```text
SKILL_OK # pi-subagent
```

The temporary qualification skill was then moved to recoverable trash.

A third real CLI drive placed `FORK_CONTEXT_731` only in the parent conversation,
launched the child with `contextMode: "fork"`, and received exactly:

```text
FORK_CONTEXT_731
```

The bounded parent projection was source/digest-bound and persisted as child
session provenance.

A fourth real CLI drive selected trusted `project` context. A temporary nested
`AGENTS.md` supplied a marker that was absent from the delegated task, and the
child returned exactly:

```text
CONTEXT_OK
```

The temporary context fixture was moved to recoverable trash. No QEMU process
remained.

The operator UX was also driven through a real Pi TUI and pseudo-terminal.
`/subagents` rendered the current-project dashboard, opened a run's tabbed detail
and state-valid action palette, and opened the retention selected/protected
report. A separate metadata-only invocation initialized and rendered the
inspector without starting QEMU. A real `ux-smoke` child then returned exactly
`UX_OK`, persisted its display metadata, and remained inspectable from a
replacement Pi session.

Active-run qualification exposed and fixed five lifecycle/UX defects: nested Pi
input dialogs were unavailable while the parent streamed, controls were offered
before the native child session was ready, seat shutdown was classified as
cancelled, resume/retry were offered without durable prerequisites, and recovered
Result views lost handoff metadata. The accepted behavior is now:

- `Alt+S` opens the inspector during the parent tool call without submitting
  editor input;
- Overview transitions from `session starting` to control `ready`;
- inspector-owned steer and follow-up inputs each produced durable
  `accepted-by-session` receipts;
- Stop produced cancelled, closed QEMU, and retained the isolated writing
  workspace;
- graceful `SIGTERM` produced interrupted, a replacement seat offered Resume,
  and Resume created attempt 2 with immutable parent lineage and a fresh VM;
- a deterministic timeout failure offered Retry and created attempt 2;
- a real writer returned `WRITE_OK`, left the active checkout clean, persisted a
  handoff commit, restored it in Result after restart, and released both the
  reservation branch and absent worktree with a durable receipt;
- output export reproduced exactly `UX_OK`; pin/unpin, cleanup-blocked
  reconciliation, safe zero-selection retention apply, current/all scope,
  search, filters, the active attention widget, and a 60-column dashboard all
  passed.

No qualified drive left a Pi-owned QEMU or runner process.

Global Pi dogfood now loads the local 0.9.0 candidate as a standalone package
alongside pi-maestro. Maestro no longer bundles a subagent extension, so normal
package loading requires no path filter. A normal Pi process with no explicit
`-e` override exposed one `subagent` tool, the `/subagents list` command routed
to the standalone store without QEMU, and a real `global-cutover` child returned
exactly `# pi-subagent`. No tool collision or QEMU process remained.

Package qualification built the 0.9.0 candidate into compiled ESM plus
declarations, produced a bounded npm archive containing no `src`, `test`, or
`spike` tree, installed that archive into a fresh temporary project, imported
both public exports, and loaded `dist/extension.js` in a fresh
`PI_CODING_AGENT_DIR`. `/subagents list` returned `No subagent runs.` without
initializing QEMU. The archive includes the project license, third-party notices,
and the Apache-2.0 text required by Gondolin.

An abrupt-seat fault drive killed Pi with `SIGKILL` only after the child native
session and QEMU were ready. The OS removed the QEMU process in this drive; the
replacement seat recovered the run as cleanup-blocked, reconciled recorded
process absence without signalling, conservatively classified missing session
persistence as failed, retained the verified clean worktree, and then released
its worktree and branch through the production service. Deterministic process
controller tests separately prove that an exact PID/start-time/command-digest
match invokes termination while a mismatched birth identity is never signalled
and remains cleanup-blocked. Session and worktree tests prove exact session ID
matching plus clean, dirty, branch-retained, absent, and mismatch-safe states.

Failure-policy dogfood used a 30-second attempt deadline inside a 90-second
run-wide budget. The real attempt persisted `timeout/service/manual`, the stable
message `Attempt runtime limit exceeded`, 30,201 measured milliseconds, and
59,799 remaining milliseconds. Explicit Retry created attempt 2 with exactly
that cumulative remainder while preserving the 30-second per-attempt deadline.
The replacement seat then interrupted attempt 2 cleanly, and all qualification
worktree/branch reservations were released.

## Important behavior

`VM.create()` resolves assets and constructs the controller, but measurements
must call `vm.start()` explicitly before recording boot completion or host PID.
Relying on the first filesystem or exec operation to trigger lazy startup gives
misleading timing and identity evidence.

Aborting a Gondolin `vm.exec()` rejects the host-side promise but does not by
itself guarantee termination of the guest process. Attempt cancellation and bash
tool timeout now close the whole per-attempt VM and prove its QEMU process
terminal. Focused qualification ran `sleep 3; write` with a one-second tool
timeout: the VM was closed before the error returned, the delayed host-backed
write remained absent after 3.5 seconds, reuse was unavailable, and no QEMU
remained.

`RealFSProvider` has no built-in workspace quota. The spike wraps it with
`SandboxVfsProvider` and reserves a cumulative byte budget before each write,
write-file, or truncate operation. This safely limits host write amplification,
but the production wrapper still needs adversarial coverage for every VFS
mutation path and concurrent handles.

The recursive `grep` and `find` operations intentionally remain lightweight and
do not claim complete local-tool or ignore-file parity. Focused drives found no
practical host-stall defect: cancellation of a 2,000-file `find` returned in 53
milliseconds while VM closure completed, and 5,000 grep matches produced a
2,311-byte bounded result with the exact 100-match notice. No arbitrary traversal
limits are imposed. A host-absolute workspace symlink could not resolve through
the VFS provider. A host environment sentinel was absent in the guest; only the
explicit locale/terminal allowlist plus guest `HOME`/`TMPDIR` remains.

Gondolin's memory and CPU options constrain each QEMU instance, but global
capacity is outside Gondolin. pi-subagent now reserves deterministic localhost
TCP listeners as OS-owned capacity slots. Binding is atomic across seat
processes, the OS releases a slot on process death, unrelated port occupation
reduces capacity safely, and guest internal-network blocking prevents access to
the lease ports. An atomically installed policy file rejects seats configured
with a different slot count or port range. Per-slot JSON records are
observational rather than authoritative.

## Remaining qualification

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
