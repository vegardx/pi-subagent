import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	AgentDiscoveryError,
	discoverAgents,
} from "../src/preflight/agents.js";

function root(name: string): string {
	return path.resolve(".pi", "test-agents", `${name}-${randomUUID()}`);
}

function definition(name: string, prompt: string, tools = ["read"]): string {
	return `---
name: ${name}
model:
  provider: github-copilot
  id: gpt-5.6-luna
  thinking: low
tools: [${tools.join(", ")}]
skills: []
workspaceModes: [read-only]
limits:
  runtimeMs: 60000
  tokens: 100000
  cost: 10
  outputBytes: 1048576
  workspaceWriteBytes: 0
  retries: 1
  resumes: 1
---
${prompt}
`;
}

async function sourceDirectory(name: string): Promise<string> {
	const directory = root(name);
	await mkdir(directory, { recursive: true });
	return directory;
}

describe("agent discovery", () => {
	it("applies deterministic scope precedence", async () => {
		const builtin = await sourceDirectory("builtin");
		const global = await sourceDirectory("global");
		const project = await sourceDirectory("project");
		await writeFile(
			path.join(builtin, "reviewer.md"),
			definition("reviewer", "builtin"),
		);
		await writeFile(
			path.join(global, "reviewer.md"),
			definition("reviewer", "global"),
		);
		await writeFile(
			path.join(project, "reviewer.md"),
			definition("reviewer", "project", ["read", "grep"]),
		);
		const agents = await discoverAgents([
			{ scope: "project", directory: project, trusted: true },
			{ scope: "builtin", directory: builtin, trusted: true },
			{ scope: "global", directory: global, trusted: true },
		]);
		expect(agents.get("reviewer")?.prompt).toBe("project");
		expect(agents.get("reviewer")?.tools).toEqual(["read", "grep"]);
		expect(agents.get("reviewer")?.sha256).toMatch(/^[a-f0-9]{64}$/);
	});

	it("refuses untrusted project sources", async () => {
		const project = await sourceDirectory("untrusted");
		await expect(
			discoverAgents([
				{ scope: "project", directory: project, trusted: false },
			]),
		).rejects.toThrow("project agent source is not trusted");
	});

	it("rejects malformed and mismatched definitions", async () => {
		const malformed = await sourceDirectory("malformed");
		await writeFile(path.join(malformed, "worker.md"), "no frontmatter");
		await expect(
			discoverAgents([
				{ scope: "global", directory: malformed, trusted: true },
			]),
		).rejects.toBeInstanceOf(AgentDiscoveryError);

		const mismatched = await sourceDirectory("mismatched");
		await writeFile(
			path.join(mismatched, "worker.md"),
			definition("other", "prompt"),
		);
		await expect(
			discoverAgents([
				{ scope: "global", directory: mismatched, trusted: true },
			]),
		).rejects.toThrow("agent name does not match file");
	});

	it("rejects duplicate names in one scope across source directories", async () => {
		const first = await sourceDirectory("duplicate-a");
		const second = await sourceDirectory("duplicate-b");
		await writeFile(
			path.join(first, "worker.md"),
			definition("worker", "first"),
		);
		await writeFile(
			path.join(second, "worker.md"),
			definition("worker", "second"),
		);
		await expect(
			discoverAgents([
				{ scope: "package", directory: first, trusted: true },
				{ scope: "package", directory: second, trusted: true },
			]),
		).rejects.toThrow("duplicate agent in scope");
	});
});
