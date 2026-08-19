import { randomUUID } from "node:crypto";
import { mkdir, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentLaunchPlan } from "../src/launch-contracts.js";
import {
	assertContextFileProjection,
	ContextFileProjectionError,
	discoverAndProjectContextFiles,
} from "../src/preflight/context-files.js";

async function fixture() {
	const root = path.join(tmpdir(), `pi-subagent-context-files-${randomUUID()}`);
	const agentDir = path.join(root, "agent");
	const project = path.join(root, "project");
	const cwd = path.join(project, "src");
	await mkdir(agentDir, { recursive: true });
	await mkdir(cwd, { recursive: true });
	await writeFile(path.join(agentDir, "AGENTS.md"), "GLOBAL_CONTEXT_MARKER\n");
	await writeFile(path.join(project, "AGENTS.md"), "PROJECT_CONTEXT_MARKER\n");
	return { agentDir, project, cwd };
}

describe("context file projection", () => {
	it("projects selected global and trusted-project scopes", async () => {
		const data = await fixture();
		const projection = await discoverAndProjectContextFiles({
			cwd: data.cwd,
			workspaceRoot: data.project,
			agentDir: data.agentDir,
			projectTrusted: true,
			scopes: ["global", "project"],
		});
		expect(projection.files).toHaveLength(2);
		expect(projection.files.map((file) => file.scope)).toEqual([
			"global",
			"project",
		]);
		expect(projection.files.map((file) => file.content).join("\n")).toContain(
			"GLOBAL_CONTEXT_MARKER",
		);
		expect(projection.files.map((file) => file.content).join("\n")).toContain(
			"PROJECT_CONTEXT_MARKER",
		);
		for (const file of projection.files) {
			expect(file.guestFilePath).toMatch(/^\/context\//);
			expect(file.grant.kind).toBe("context");
		}
	});

	it("does not project project context without trust", async () => {
		const data = await fixture();
		await expect(
			discoverAndProjectContextFiles({
				cwd: data.cwd,
				workspaceRoot: data.project,
				agentDir: data.agentDir,
				projectTrusted: false,
				scopes: ["project"],
			}),
		).rejects.toThrow("project context requires a trusted project");
	});

	it("rejects repository context symlinks that escape the workspace", async () => {
		const data = await fixture();
		const secret = path.join(data.project, "..", "outside-context.md");
		await writeFile(secret, "OUTSIDE\n");
		await writeFile(path.join(data.project, "AGENTS.md"), "temporary\n");
		const contextPath = path.join(data.project, "AGENTS.md");
		await unlink(contextPath);
		await symlink(secret, contextPath);
		await expect(
			discoverAndProjectContextFiles({
				cwd: data.cwd,
				workspaceRoot: data.project,
				agentDir: data.agentDir,
				projectTrusted: true,
				scopes: ["project"],
			}),
		).rejects.toThrow("repository context file cannot escape");
	});

	it("detects projection drift against launch grants", async () => {
		const data = await fixture();
		const projection = await discoverAndProjectContextFiles({
			cwd: data.cwd,
			workspaceRoot: data.project,
			agentDir: data.agentDir,
			projectTrusted: true,
			scopes: ["global"],
		});
		const plan = {
			resources: projection.files.map((file) => file.grant),
		} as AgentLaunchPlan;
		assertContextFileProjection(plan, projection);
		const changed = structuredClone(projection);
		const changedFile = changed.files[0];
		if (!changedFile) throw new Error("context fixture missing");
		changedFile.grant.sha256 = "0".repeat(64);
		expect(() => assertContextFileProjection(plan, changed)).toThrow(
			ContextFileProjectionError,
		);
	});
});
