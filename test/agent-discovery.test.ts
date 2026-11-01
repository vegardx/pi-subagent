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
preloadSkills: []
contextScopes: []
workspaceModes: [read-only]
limits:
  cumulativeRuntimeMs: 60000
  attemptTimeoutMs: 30000
  totalTokens: 100000
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

	it("lets a definition that hands the model to the host omit its default", async () => {
		const unpinned = (name: string, allowed: string) =>
			definition(name, "prompt").replace(
				"model:\n  provider: github-copilot\n  id: gpt-5.6-luna\n  thinking: low\n",
				`allowedModels: [${allowed}]\n`,
			);
		const directory = await sourceDirectory("unpinned");
		await writeFile(
			path.join(directory, "routed.md"),
			unpinned("routed", "host"),
		);
		await writeFile(
			path.join(directory, "inheriting.md"),
			unpinned("inheriting", "inherit"),
		);
		await writeFile(
			path.join(directory, "pinned.md"),
			definition("pinned", "prompt").replace(
				"tools:",
				"allowedModels: [github-copilot/gpt-5.6-luna:low, host]\ntools:",
			),
		);
		const agents = await discoverAgents([
			{ scope: "global", directory, trusted: true },
		]);
		expect(agents.get("routed")?.defaultModel).toBeUndefined();
		expect(agents.get("routed")?.allowedModels).toEqual(["host"]);
		expect(agents.get("inheriting")?.defaultModel).toBeUndefined();
		expect(agents.get("inheriting")?.allowedModels).toEqual(["inherit"]);
		expect(agents.get("pinned")?.defaultModel).toEqual({
			provider: "github-copilot",
			id: "gpt-5.6-luna",
			thinking: "low",
		});
		expect(agents.get("pinned")?.allowedModels).toEqual([
			"github-copilot/gpt-5.6-luna:low",
			"host",
		]);

		const fenced = await sourceDirectory("unpinned-fenced");
		await writeFile(
			path.join(fenced, "worker.md"),
			unpinned("worker", "github-copilot/gpt-5.6-luna:low"),
		);
		await expect(
			discoverAgents([{ scope: "global", directory: fenced, trusted: true }]),
		).rejects.toThrow(
			"agent definition names no model and its allowedModels admit neither inherit nor host",
		);
		const bare = await sourceDirectory("unpinned-bare");
		await writeFile(
			path.join(bare, "worker.md"),
			definition("worker", "prompt").replace(
				"model:\n  provider: github-copilot\n  id: gpt-5.6-luna\n  thinking: low\n",
				"",
			),
		);
		await expect(
			discoverAgents([{ scope: "global", directory: bare, trusted: true }]),
		).rejects.toThrow(
			"agent definition names no model and its allowedModels admit neither inherit nor host",
		);
		const outside = await sourceDirectory("pinned-outside");
		await writeFile(
			path.join(outside, "worker.md"),
			definition("worker", "prompt").replace(
				"tools:",
				"allowedModels: [host]\ntools:",
			),
		);
		await expect(
			discoverAgents([{ scope: "global", directory: outside, trusted: true }]),
		).rejects.toThrow("default model exceeds agent model ceiling");
	});

	it("defaults, accepts, and validates the VM memory ceiling", async () => {
		const directory = await sourceDirectory("memory");
		await writeFile(
			path.join(directory, "default-memory.md"),
			definition("default-memory", "prompt"),
		);
		await writeFile(
			path.join(directory, "raised-memory.md"),
			definition("raised-memory", "prompt").replace(
				"---\nprompt",
				`memoryBytes: ${2 * 1024 * 1024 * 1024}\n---\nprompt`,
			),
		);
		const agents = await discoverAgents([
			{ scope: "global", directory, trusted: true },
		]);
		expect(agents.get("default-memory")?.memoryCeilingBytes).toBe(
			1024 * 1024 * 1024,
		);
		expect(agents.get("raised-memory")?.memoryCeilingBytes).toBe(
			2 * 1024 * 1024 * 1024,
		);

		for (const invalid of [
			0,
			64 * 1024 * 1024,
			100 * 1024 * 1024,
			960 * 1024 * 1024,
			-64 * 1024 * 1024,
			5 * 1024 * 1024 * 1024,
		]) {
			const rejected = await sourceDirectory(`memory-${invalid}`);
			await writeFile(
				path.join(rejected, "worker.md"),
				definition("worker", "prompt").replace(
					"---\nprompt",
					`memoryBytes: ${invalid}\n---\nprompt`,
				),
			);
			await expect(
				discoverAgents([
					{ scope: "global", directory: rejected, trusted: true },
				]),
			).rejects.toThrow("invalid agent frontmatter");
		}
	});

	it("refuses a definition whose memory ceiling is below the 1 GiB floor", async () => {
		const directory = await sourceDirectory("memory-floor");
		await writeFile(
			path.join(directory, "worker.md"),
			definition("worker", "prompt").replace(
				"---\nprompt",
				`memoryBytes: ${512 * 1024 * 1024}\n---\nprompt`,
			),
		);
		const refusal = discoverAgents([
			{ scope: "global", directory, trusted: true },
		]);
		await expect(refusal).rejects.toBeInstanceOf(AgentDiscoveryError);
		await expect(refusal).rejects.toThrow(
			`(/memoryBytes: must be >= ${1024 * 1024 * 1024})`,
		);
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
