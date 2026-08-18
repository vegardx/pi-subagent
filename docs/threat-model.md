# Threat model

## Protected properties

- A child receives only its declared model, resources, tools, and workspace.
- Run state cannot claim unobserved launch, delivery, completion, or cleanup.
- A project cannot supply agents/resources before Pi project trust.
- Provider credential material held by the runtime does not enter child prompts, journals, or artifacts.
- Parallel mutating children cannot share an unisolated checkout accidentally.
- Process cleanup proof is scoped to tracked birth identities/process groups
  unless a stronger sandbox boundary can enumerate escaped descendants.

## Trust boundaries

| Boundary | Assumption |
| --- | --- |
| Pi and installed trusted extensions | Trusted code with user authority |
| User-global agent definitions | Trusted configuration |
| Project agents/resources | Untrusted until Pi project trust |
| Model output and fetched content | Untrusted data/instructions |
| Child process | Cooperative by default; potentially confused or tool-injected |
| Same-UID hostile process | Outside strong guarantees unless an OS sandbox/broker isolates state |

## Supervisor state

Authoritative state lives under a private supervisor root outside child
workspaces:

```text
<getAgentDir()>/subagents/projects/<project-id>/runs/<run-id>/
```

Children receive no supervisor-store path. File permissions protect against
other OS users, not a hostile same-UID process. Strong evidence against a
hostile child requires an OS sandbox denying the supervisor root or an external
broker with capabilities unavailable to the child.

The initial runtime claims crash consistency and protection against accidental
child writes—not protection from a malicious same-UID process. Owner-bound
service clients are cooperative authorization between trusted extensions, not
protection against arbitrary installed code. Documentation and tests must
preserve these distinctions.

## Extension providers

Loading an extension executes arbitrary code before tool allowlisting matters.
Provider grants therefore include trusted provenance, canonical path, content
digest, and required sandbox/environment policy. A descriptive tool
classification alone is not an authority boundary.

## Worktrees and sandboxes

A worktree separates Git state but does not restrict reads, writes, processes,
or network. Sandboxing and write confinement are separate grants. Requested
isolation never silently degrades.
