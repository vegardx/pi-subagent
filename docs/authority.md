# Authority model

## Principles

- The runtime grants the least authority needed by one attempt.
- Agent definitions set ceilings; calls may only narrow them.
- Ambient child extensions are disabled by default.
- A tool grant and the extension implementing it are one registry declaration.
- Project-controlled agents and resources require Pi project trust.
- Worktrees isolate Git state, not operating-system access.
- Sandboxing and filesystem write confinement must be enforced below prompts.

## Capability resolution

```text
agent definition ceiling
  ∩ caller grant
  ∩ backend support
  ∩ workspace policy
  ∩ project trust
  = effective launch plan
```

Unknown tools, providers, or resources fail before child startup.

## Tool providers

A provider declaration binds stable capability names to concrete extension
resources and tools:

```ts
interface ToolProviderDeclaration {
	id: string;
	extensionPath: string;
	source: SourceInfo;
	contentSha256: string;
	tools: readonly string[];
	classification: "read-only" | "write" | "network" | "control";
	requiredSandboxProfile?: string;
}
```

For example, a `pi-web-access` provider may implement `web_search`,
`source_check`, `fetch_content`, and `get_search_content`. The child receives the
real provider extension directly; the runtime does not generate wrapper source.
Loading an extension executes arbitrary initialization and hooks, so provider
trust and sandbox policy cover the extension as code—not only its listed tools.

## Resource defaults

| Resource | Default |
| --- | --- |
| Extensions | None |
| Skills | None unless the agent definition grants them |
| Context files | Explicit policy; project context requires trust |
| Built-in tools | Explicit allowlist |
| Recursive subagent tool | Denied |
| Network | Backend/sandbox policy |

## Workspaces

A requested worktree or sandbox is a contract. Failure to create it fails the
attempt before the model runs. There is no fallback to shared mutation.

Mutating parallel attempts require separate worktrees. Work must be captured as
a patch, commit, or declared artifact before cleanup. Uncertain workspaces are
retained for diagnosis.

## Secrets

Launch plans, journals, logs, and tool output must redact credential-shaped
fields. Provider credentials remain owned by Pi's model runtime and are never
copied into run records.
