# Research source ledger

Initial architecture research inspected these source snapshots. Behavioral claims
must cite a pinned snapshot before source is adapted.

| Project | Repository | Snapshot | License | Focus |
| --- | --- | --- | --- | --- |
| Pi | <https://github.com/earendil-works/pi-mono> | installed `@earendil-works/pi-coding-agent` 0.84.2 | MIT | SDK, resource loader, native sessions, tool factories, Gondolin and sandbox examples |
| Gondolin | <https://github.com/earendil-works/gondolin> | `29fa74d802112f29c720990aced26165e0d57d84`; package 0.12.0 inspected | Apache-2.0 | QEMU VM, VFS, networking, security model, limitations, Pi integration |
| Anthropic Sandbox Runtime | <https://github.com/anthropic-experimental/sandbox-runtime> | `bcad38810efcc2b7342bbc6ec26d15b7bbbabcfb`; package 0.0.73 inspected | Apache-2.0 | Seatbelt/Bubblewrap policy sandbox alternative |
| pi-sandbox | <https://github.com/erichll/pi-packages/tree/main/packages/pi-sandbox> | `5dea625c0ff3a50bc3f344c59e93567b57b43d43` | MIT | Per-command SRT broker, network policy, process-backed subagents |
| tintinweb/pi-subagents | <https://github.com/tintinweb/pi-subagents> | `0a3864077848ed4b4fee73f74443e0b2c7f65938` | MIT | In-process AgentSession resource isolation and worktrees |
| pi-subagentura | <https://github.com/lmn451/pi-subagentura> | `fd7e979c1a9037bc3c96aeaf8c9e30f27dd96be8` | MIT | Process-backed subagent implementation |
| pi-subagent | <https://github.com/AgwaB/pi-subagent> | `34cdcb04ec94e35d030b2dd77df7aede841b9f8d` | MIT | attempts, launch barriers, process identity, worktrees |
| pi-workflow | <https://github.com/AgwaB/pi-workflow> | `aed281903a07cfa59e54277bb66de9e6c3f865ab` | MIT | scheduler/subagent split and recovery |
| pi-subagents | <https://github.com/nicobailon/pi-subagents> | `8c5269b22253c0cf5af690199fda384dc40b8e0c` | MIT | capability plans, control channel, process cleanup, resume |
| pi-crew | <https://github.com/melihmucuk/pi-crew> | `47503f068258be488ae028696b35a1ebaacf6f75` | MIT | delegation envelope and owner routing |
| pi-baton | <https://github.com/eiei114/pi-baton> | `9fda443e86c32cbcb363f72e7ff88aeb8f170409` | MIT declaration; notice requires verification | Narrow review state machine |
| pi-workflow-engine | <https://github.com/timbrinded/pi-workflow-engine> | `b594e32a5f3eb07e12593022a856bb21bdaf4ded` | MIT | typed workflow, replay identity, structured output, worktrees |
| pi-dynamic-workflows | <https://github.com/QuintinShaw/pi-dynamic-workflows> | `f1e05aa766b729788e9c53892cfa0dd940aa36e1` | MIT | capability contract, checkpoints, workflow UI |

Additional candidates require source inspection only if their concepts are
proposed for adoption. No uninspected implementation is an architecture
dependency.
