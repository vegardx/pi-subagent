import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
	preflightWorkspace,
	WorkspacePreflightError,
} from "../src/preflight/workspace.js";

const execFileAsync = promisify(execFile);

function fixture(name: string): string {
	return path.resolve(".pi", "test-workspaces", `${name}-${randomUUID()}`);
}

async function git(cwd: string, ...args: string[]): Promise<void> {
	await execFileAsync("git", args, { cwd });
}

async function repository(name: string): Promise<string> {
	const root = fixture(name);
	await mkdir(path.join(root, "src"), { recursive: true });
	await git(root, "init", "--quiet");
	await git(root, "config", "user.name", "Qualification");
	await git(root, "config", "user.email", "qualification@example.invalid");
	await writeFile(
		path.join(root, "src", "index.ts"),
		"export const value = 1;\n",
	);
	await git(root, "add", ".");
	await git(root, "commit", "--quiet", "-m", "initial");
	return root;
}

describe("workspace preflight", () => {
	it("resolves clean worktree baselines from repository subdirectories", async () => {
		const root = await repository("clean");
		const result = await preflightWorkspace({
			mode: "worktree",
			cwd: path.join(root, "src"),
		});
		expect(result.repositoryRoot).toBe(root);
		expect(result.relativeCwd).toBe("src");
		expect(result.dirty).toBe(false);
		expect(result.head).toMatch(/^[a-f0-9]{40,64}$/);
		expect(result.baselineSha256).toMatch(/^[a-f0-9]{64}$/);
	});

	it("binds tracked and untracked read-only changes", async () => {
		const root = await repository("dirty-read");
		const clean = await preflightWorkspace({ mode: "read-only", cwd: root });
		await writeFile(
			path.join(root, "src", "index.ts"),
			"export const value = 2;\n",
		);
		await writeFile(path.join(root, "untracked.txt"), "first\n");
		const dirty = await preflightWorkspace({ mode: "read-only", cwd: root });
		expect(dirty.dirty).toBe(true);
		expect(dirty.baselineSha256).not.toBe(clean.baselineSha256);
		await writeFile(path.join(root, "untracked.txt"), "second\n");
		const changed = await preflightWorkspace({ mode: "read-only", cwd: root });
		expect(changed.baselineSha256).not.toBe(dirty.baselineSha256);
	});

	it("rejects dirty writing workspaces", async () => {
		const root = await repository("dirty-write");
		await writeFile(path.join(root, "src", "index.ts"), "dirty\n");
		await expect(
			preflightWorkspace({ mode: "worktree", cwd: root }),
		).rejects.toThrow("worktree workspace requires a clean repository");
	});

	it("rejects paths outside Git repositories", async () => {
		const root = path.join(tmpdir(), `pi-subagent-not-git-${randomUUID()}`);
		await mkdir(root, { recursive: true });
		await expect(
			preflightWorkspace({ mode: "read-only", cwd: root }),
		).rejects.toBeInstanceOf(WorkspacePreflightError);
	});
});
