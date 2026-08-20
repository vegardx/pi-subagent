# Acceptance inventory

This inventory defines evidence required before stable releases. Unit tests or
mocks alone do not prove VM isolation.

## Qualification gate

Before production implementation:

- QEMU capability probe succeeds on the supported macOS Apple Silicon host;
- pinned Gondolin package and image boot successfully;
- a disposable workspace mounts at `/workspace`;
- Pi `read`, `write`, `edit`, `bash`, `grep`, `find`, and `ls` operations execute
  through the VM;
- host home, Pi agent directory, runtime store, and unrelated paths are
  unreachable;
- repository-local files, including `.env`, remain visible;
- public internet works while localhost, private ranges, link-local addresses,
  and cloud metadata endpoints fail;
- two native sessions run concurrently in separate VMs without shared writable
  state;
- cancellation closes one VM without affecting the other;
- boot latency, memory, disk cache, and shutdown latency are measured;
- configured VM memory/concurrency and guest-overlay/workspace growth limits are
  enforced before host exhaustion.

A failed qualification item is a backend finding. Tests or policy must not be
weakened and host execution must not be used as fallback.

## Launch and resources

- a native `AgentSession` reaches authoritative settlement;
- one attempt creates exactly one VM and no child Pi process;
- ambient extensions, prompts, themes, and context files are absent;
- normal global/package and trusted-project skill metadata is discoverable;
- untrusted project skills are absent;
- skill trees are mounted read-only under guest `/skills` paths;
- `preloadSkills` content is present before the first model turn;
- agent-required and request-selected context scopes are unioned;
- global context is explicit and project context requires Pi project trust;
- projected context is digest-bound, injected before the first turn, readable
  under synthetic `/context` guest paths, and rejects writes;
- repository context symlinks cannot escape the selected checkout;
- only explicit tools, preloads, and context are projected beyond the normal
  skill catalog;
- effective model, thinking, session, tools, resource identities, workspace,
  image, mount policy, and network policy match preflight;
- resource or policy changes between preflight and launch are rejected;
- project resources follow Pi trust;
- custom provider models work without mounting host provider credentials.

## Operator UX

- metadata inspection does not initialize model providers, Gondolin assets, VM
  capacity, or QEMU;
- current-project listing includes prior-session owners and can explicitly toggle
  all projects;
- run listing, search, lifecycle logs, and detail views are bounded and
  paginated;
- full-screen rendering never exceeds terminal width and remains usable without
  color;
- Overview, Activity, Result, and Technical tabs preserve selection across live
  status events;
- `Alt+S` can open the inspector during a parent tool call without submitting
  editor input;
- steer/follow-up remain hidden until the native child session reports control
  readiness, then produce durable `accepted-by-session`, `missed`, or `failed`
  receipts;
- streaming-time control text and confirmations remain inside the inspector
  rather than relying on nested Pi dialogs;
- retry/resume appear only when count budgets and durable result/session
  prerequisites prove eligibility;
- inspector and direct commands consume the same service-owned action
  projection; no second status-to-action table can drift;
- only state-valid actions appear, and destructive/costly actions require
  confirmation;
- pin/unpin appear only for ordinary terminal history where they change
  retention behavior;
- the widget separates ongoing work from interrupted/cleanup-blocked runs that
  need action, and is absent when neither group is present;
- abandoned runs remain in history but are absent from the widget;
- graceful seat shutdown classifies active work as interrupted while explicit
  operator stop remains cancelled;
- reload can inspect and retry/resume a dynamic agent from persisted authority
  without an in-memory agent definition;
- recovered Result views restore persisted handoff metadata and can release the
  verified worktree/branch reservation;
- non-TUI command paths return bounded summaries without opening custom UI;
- operator inspection or refresh never starts a VM.

## Accidental-damage containment

Inside a disposable fixture, test commands equivalent to:

```text
rm -rf /workspace
rm -rf ~
find / -type f -delete
chmod -R 000 /
kill -9 -1
```

Acceptance requires:

- destructive effects remain inside the disposable guest/workspace boundary;
- host home, Pi state, active checkout, unrelated fixtures, and host processes
  remain unchanged;
- a read-only workspace rejects destructive writes;
- a writing attempt may destroy its private worktree without affecting the
  active checkout or another attempt;
- VM closure terminates all guest processes;
- no host-backed mutating tool bypass exists.

These tests run only against disposable fixtures with explicit sentinels. They
must never target a real home or active repository.

## Resource exhaustion

Using bounded disposable fixtures:

- a guest cannot allocate memory beyond its configured VM limit;
- global and per-owner VM concurrency limits prevent accidental fan-out across
  multiple Pi seat processes;
- guest root-overlay growth has a hard maximum;
- writes through the workspace VFS stop at a configured byte quota;
- output and artifact streams truncate or fail at documented bounds;
- a fork loop or CPU loop remains confined and is stopped by cancellation or
  timeout;
- quota failure cannot trigger fallback to an unbounded host path.

## Filesystem and tools

- every granted built-in operation is VM-backed;
- denied or undeclared host-backed tools cannot be invoked;
- read-only checkout mounts reject all writes;
- writing attempts use distinct private worktrees;
- traversal, absolute host paths, symlink escape, and VFS-provider escape fail;
- ordinary broad grep/find remain allowed; focused cancellation and output drives
  prove bounded parent output and VM-close containment without imposing arbitrary
  repository-size limits;
- host home, Pi config, runtime store, and unrelated repositories are absent;
- repository-local `.env` and similar files are visible under the workspace's
  normal read/write mode;
- user shell commands, when enabled, use the same VM path as `bash`;
- guest commands receive only bounded locale/terminal variables plus guest
  `HOME`/`TMPDIR`; arbitrary host environment variables are absent;
- a bash tool timeout closes and fences the entire attempt VM, proves QEMU
  absence, prevents late writes, and prevents subsequent VM reuse;
- arbitrary child extension code is absent.

## Network

- ordinary public HTTP and HTTPS destinations work;
- DNS and redirects are mediated by Gondolin;
- loopback, private, link-local, metadata, and DNS-rebinding targets fail;
- guest commands cannot reach services bound only to the host or local network;
- the runtime does not claim to prevent public-network exfiltration;
- host Pi/provider credentials remain absent unless they are themselves copied
  into the selected repository by the user.

## Idempotency and lifecycle

- concurrent duplicate operation ID from separate seats creates one attempt;
- the same operation ID with a different request identity fails;
- a live owning seat fences another seat from run, session, worktree, and
  cleanup mutation;
- stale lease reclamation requires host-process and VM terminal evidence;
- retry creates a new attempt and fresh VM;
- graceful stop aborts the session, closes the VM, and records workspace state;
- seat reload/exit marks active work interrupted rather than completed;
- explicit resume validates the retained session and workspace, then creates a
  fresh VM;
- explicit abandon accepts only interrupted runs with proved sandbox cleanup,
  safely releases verified retained workspaces, removes resume/retry authority,
  and records an immutable operator-abandoned result;
- abandonment races with resume, reconcile, and workspace release have one
  fenced winner;
- no contract claims detached execution or survival across seat exit;
- run-wide limits survive retry and resume.

## Cancellation and cleanup

- stop races with launch and completion have one winner;
- guest work cannot outlive proved VM closure;
- VM-close timeout or unknown QEMU identity becomes cleanup-blocked;
- no completion is reported while VM shutdown is unproved;
- cancellation preserves uncaptured worktree changes;
- closing one VM does not terminate another attempt's VM;
- repeated cleanup is idempotent;
- cleanup-blocked runs cannot be abandoned or forgotten; they must reconcile to
  proved cleanup first.

## Workspaces and handoff

- worktree requests fail outside Git and never fall back;
- parallel writers receive distinct worktrees;
- the VM does not receive unrestricted common Git metadata;
- binary, mode, symlink, rename, and deletion changes survive handoff;
- authoritative host Git runs with hooks/signing/fsmonitor disabled and a minimal
  non-secret environment; repository pre-commit hooks cannot execute;
- commit or artifact handoff is durable before cleanup;
- uncertain worktrees are retained;
- cleanup failure blocks successful terminal status;
- explicit release removes only the recorded worktree after identity checks.

## Persistence and recovery

- torn journal tail, corrupt snapshot, and unknown schema fail closed;
- stale `active` state after seat loss reconciles to interrupted or
  cleanup-blocked, never completed;
- a stale QEMU process is never adopted; termination requires exact recorded PID,
  process birth time, qualified-QEMU command digest, and per-signal identity
  revalidation;
- PID reuse, a non-QEMU process, malformed identity, or command mismatch is never
  signalled and remains cleanup-blocked;
- retained session recovery requires canonical session-root containment and an
  exact durable `SessionManager` identity match;
- worktree reconciliation verifies canonical path, Git root, branch, HEAD,
  status, expected baseline/handoff commit, release receipt, and branch-only
  retention before classification;
- a stale process blocks reuse of its worktree until termination is proved;
- files use private modes and bounded serialization;
- every non-completed terminal result has one bounded stable failure code,
  origin, retry disposition, message, and guidance;
- unknown failures fail closed to reconciliation rather than transient retry;
- only manual and elapsed-backoff classifications enter retry; only seat
  interruption with a retained session enters resume;
- transient retry delay grows exponentially from durable attempt ordinal and is
  capped at five minutes;
- numerical output, log, event, artifact, cumulative runtime, retry, resume,
  uncached input/output token, and cost bounds produce documented truncation or
  terminal outcomes; cache reads/writes remain telemetry rather than consuming
  the token ceiling;
- whichever of token, run-runtime, or attempt-runtime pressure first reaches
  70% and 90% persists one unified receipt per attempt stage and queues
  progressively stronger convergence steering;
- retry/resume subtract each attempt's measured runtime before compiling the next
  immutable plan and reject less than one second remaining;
- resumed sessions account only messages, tokens, cost, and output added after
  the retained-session baseline; prior assistant usage is not charged twice;
- retention never selects active, interrupted, cleanup-blocked, pinned, or
  unreleased-worktree runs;
- completed, failed, cancelled, and abandoned runs are ordinary terminal
  history; abandoned runs reconstruct without session recovery authority after
  restart;
- ordinary terminal runs older than 30 days are selected;
- the oldest ordinary runs are selected until retained ordinary data is within
  the 2 GiB budget;
- dry-run and applied reports distinguish selected, protected, and actually
  pruned runs with byte counts and reasons;
- pruning holds a cross-process retention lease and each run fence;
- a live run lease prevents pruning without signaling the owner;
- applied pruning and pin removal use recoverable trash rather than hard delete;
- every distinct worktree referenced through `worktreeAttemptId` moves with its
  run graph;
- an incomplete trash manifest resumes under retention and run leases before new
  prune selection, moving the run-record commit marker last;
- incompatible persisted contract revisions are rejected with discard guidance;
  no migration or compatibility path is provided.

## Distribution

- packed package contains compiled ESM/declarations and excludes source, tests,
  spikes, local state, archives, and build-only scripts;
- packed package installs into a fresh project, public and extension exports
  import under plain Node.js, and the extension loads in a fresh
  `PI_CODING_AGENT_DIR` without starting QEMU;
- Gondolin is pinned behind the project adapter and third-party notices plus
  required dependency license texts are present;
- tool and command ownership has no collisions;
- public runtime capability contract matches implementation exactly;
- supported Pi, Node, Gondolin, image, QEMU, and macOS Apple Silicon ranges are
  tested and documented;
- CI on an unsupported host is described only as build portability evidence,
  never runtime or release support;
- the extension registers one lazy service provider without initializing the
  runtime, and standalone use requires no consumer package;
- provider discovery returns the exact extension-owned service and fails for
  missing, duplicate, or incompatible providers;
- provider registration is removed on session shutdown and consumers do not
  own service shutdown;
- `pi-workflow` uses the public service without creating another runtime;
- incompatible consumer contract revisions fail startup instead of receiving a
  compatibility shim.
