# Gondolin qualification — 0.14.0, macOS arm64

Date: 2026-10-31. The 0.12.0 qualification of 2026-08-19 is kept in
`gondolin-darwin-arm64.md`.

## Environment

| Component | Version |
| --- | --- |
| macOS architecture | arm64 (18 cores, 128 GiB) |
| Node.js | 24.16.0 |
| Pi | 1.4.0 |
| Gondolin | 0.14.0 |
| Guest image | `alpine-base:0.4.0`, build `9ec8f6c5-bd1f-5ac8-9bc2-2efd531c2359` |
| QEMU | 11.1.0 |
| Model drive | `github-copilot/gpt-5.6-luna` |

`ensureGuestAssets()` does not fetch a new image after a Gondolin upgrade: it
prefers the locally cached `alpine-base:latest` ref, which on this host still
pointed at `alpine-base:0.2.0` (build `108a1836-…`, built 2026-04-21). The
runtime and the qualification therefore pin the image by its versioned ref
(`GUEST_IMAGE_SELECTOR`) and resolve it with `ensureImageSelector`, which
downloaded `alpine-base:0.4.0`, the image released with Gondolin 0.14.0.

## Result

`npm run qualify:gondolin`: 10 passed, 0 failed, 0 blocked. Every VM booted
with 1024M, one vCPU, a 4 GiB copy-on-write root disk, and no scratch tmpfs
(`tmpfs: {}`).

| Check | Result | Evidence |
| --- | --- | --- |
| read-only workspace | Pass | ReadonlyProvider rejected guest writes and preserved the host file. |
| guest storage on the root disk | Pass | /, /tmp, and /var are on /dev/vda (3904 MiB); a 256 MiB write to /var/cache/pi-subagent left MemAvailable at 888788 of 901888 KiB. |
| tool routing and host boundary | Pass | All seven Pi tools used VM operations; public HTTPS worked; internal targets and host paths were unavailable; destructive writes stayed in the fixture. |
| workspace write budget | Pass | A 1MiB guest write stopped at 131072 bytes under a 131072-byte cumulative budget and was refused as a quota error; a 1MiB write to /var/cache/pi-subagent consumed none of it. |
| concurrent VM isolation | Pass | Two 1024M/1-vCPU VMs booted concurrently and wrote only their own mounts. |
| global VM capacity lease | Pass | A host socket lease enforced one global slot at 127.0.0.1:60311 and released it for replacement. |
| production Gondolin adapter | Pass | Production adapter routed a workspace write, exposed a read-only skill namespace through VM 1d52e57d-46d6-4ff1-a3dc-6c617990ed7b, proved close, and released capacity slot 0. |
| production native attempt runner | Pass | Production runner completed attempt_93a863effa6243c68189e4c2d42b2461, reopened its persisted session in a fresh VM as attempt_b8ef5eb0b9f440309e084995c4175535, and proved both VM cleanups. |
| foreground SubagentService | Pass | Foreground service preflighted, launched idempotently, recovered after restart, and observed run_7aa9d118cb0c1e324171f446e88b1a53e1ab78558ecfbde4. |
| concurrent native AgentSessions | Pass | Two native AgentSessions completed concurrently in separate VMs with github-copilot/gpt-5.6-luna. |

QEMU boots took 813, 490, 377, 601, 593, 796 ms.

The spike's own agent fixtures still declared 512 MiB, below the 1 GiB floor
introduced in 0.19.0, so its attempt-runner and service checks failed preflight
with "agent memory ceiling is invalid" until the fixtures used the production
default. That was harness drift, not a backend finding.

## Guest memory floor

Smallest memory that boots the pinned image and runs `node -e`, probed with
`VM.create` + `start` + one `exec` and a 30 s readiness bound:

| Memory | Root disk, `tmpfs: {}` | `memory` rootfs, default tmpfs |
| --- | --- | --- |
| 1024M | boots, 881 MiB available | boots, 880 MiB available |
| 512M | boots, 420 MiB available | not probed |
| 256M | boots, 177 MiB available | not probed |
| 192M | boots, 123 MiB available | not probed |
| 128M | boots, 62 MiB available | boots, 62 MiB available |
| 96M | boots, 33 MiB available | boots, 33 MiB available |
| 64M | no readiness within 30 s | not probed |

The boot floor of this image is therefore between 64 MiB and 96 MiB, and it does
not depend on the tmpfs layout: scratch tmpfs only costs memory once something
writes to it. The 1 GiB `MIN_MEMORY_BYTES` is a workload floor for Node-based
toolchains, kept for this release. With the default tmpfs set, `/tmp` is a RAM
tmpfs capped at half the guest memory (483.7 MiB at 1024M); with `tmpfs: {}` a
256 MiB write to `/var/cache/pi-subagent` lowered `MemAvailable` by about
13 MiB (page cache dropped).

Gondolin's `memory` rootfs mode on QEMU is `-snapshot` with a host-side write
cache, not guest RAM; the root disk of the pinned image is 267.8 MiB with
173 MiB used. The `cow` mode used now is a per-VM qcow2 overlay in the host's
temporary directory, deleted at close; with `size: 4G` the guest sees a
3.8 GiB root filesystem.
