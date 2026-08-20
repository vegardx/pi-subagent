import { randomUUID } from "node:crypto";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { discoverAgents } from "../src/preflight/agents.js";
import {
	discoverPackageAgentSources,
	PackageAgentManifestError,
} from "../src/preflight/package-manifest.js";

function fixture(name: string): string {
	return path.resolve(".pi", "test-package-agents", `${name}-${randomUUID()}`);
}

function agent(): string {
	return `---
name: worker
model: { provider: github-copilot, id: gpt-5.6-luna, thinking: low }
tools: [read]
preloadSkills: []
contextScopes: []
workspaceModes: [read-only]
limits:
  runtimeMs: 60000
  attemptRuntimeMs: 30000
  tokens: 100000
  cost: 10
  outputBytes: 1048576
  workspaceWriteBytes: 0
  retries: 1
  resumes: 1
---
Package worker.
`;
}

async function writeManifest(root: string, directories: string[]) {
	const manifestPath = path.join(root, "pi-subagent.json");
	await writeFile(
		manifestPath,
		`${JSON.stringify(
			{
				schema: "pi-subagent-package",
				contractRevision: 3,
				agentDirectories: directories,
			},
			null,
			2,
		)}\n`,
	);
	return manifestPath;
}

describe("package agent manifests", () => {
	it("discovers package-scoped agent directories", async () => {
		const root = fixture("valid");
		const agentsDirectory = path.join(root, "agents");
		await mkdir(agentsDirectory, { recursive: true });
		await writeFile(path.join(agentsDirectory, "worker.md"), agent());
		const manifestPath = await writeManifest(root, ["agents"]);
		const discovered = await discoverPackageAgentSources(manifestPath);
		expect(discovered.manifest.sha256).toMatch(/^[a-f0-9]{64}$/);
		expect(discovered.sources).toEqual([
			{ scope: "package", directory: agentsDirectory, trusted: true },
		]);
		const agents = await discoverAgents(discovered.sources);
		expect(agents.get("worker")?.prompt).toBe("Package worker.");
	});

	it("rejects absolute and escaping directories", async () => {
		const root = fixture("escape");
		const packageRoot = path.join(root, "package");
		const outside = path.join(root, "outside");
		await mkdir(packageRoot, { recursive: true });
		await mkdir(outside, { recursive: true });
		await expect(
			discoverPackageAgentSources(await writeManifest(packageRoot, [outside])),
		).rejects.toThrow("must be relative");
		await expect(
			discoverPackageAgentSources(
				await writeManifest(packageRoot, ["../outside"]),
			),
		).rejects.toThrow("escapes package");
	});

	it("rejects malformed, missing, and non-directory sources", async () => {
		const root = fixture("invalid");
		await mkdir(root, { recursive: true });
		const malformed = path.join(root, "malformed.json");
		await writeFile(malformed, "{broken");
		await expect(discoverPackageAgentSources(malformed)).rejects.toBeInstanceOf(
			PackageAgentManifestError,
		);
		const linked = path.join(root, "linked.json");
		await symlink("malformed.json", linked);
		await expect(discoverPackageAgentSources(linked)).rejects.toThrow(
			"manifest symlink denied",
		);
		await expect(
			discoverPackageAgentSources(await writeManifest(root, ["missing"])),
		).rejects.toThrow("unavailable");
		await writeFile(path.join(root, "file"), "not a directory");
		await expect(
			discoverPackageAgentSources(await writeManifest(root, ["file"])),
		).rejects.toThrow("not a directory");
	});
});
