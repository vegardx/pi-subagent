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

async function git(cwd: string, ...args: string[]): Promise<string> {
	return (await execFileAsync("git", args, { cwd })).stdout.trim();
}

/**
 * Builds a commit on HEAD without moving HEAD, the shape a captured hand-off
 * has, and optionally pins it under a hand-off ref.
 */
async function commitOn(
	root: string,
	parent: string,
	content: string,
	ref?: string,
): Promise<string> {
	const blob = await execFileAsync(
		"sh",
		["-c", `printf %s "$1" | git hash-object -w --stdin`, "sh", content],
		{ cwd: root },
	);
	const tree = await execFileAsync(
		"sh",
		[
			"-c",
			`printf '100644 blob %s\\tindex.ts\\n' "$1" | git mktree`,
			"sh",
			blob.stdout.trim(),
		],
		{ cwd: root },
	);
	const commit = await git(
		root,
		"commit-tree",
		tree.stdout.trim(),
		"-p",
		parent,
		"-m",
		"handoff",
	);
	if (ref) await git(root, "update-ref", ref, commit);
	return commit;
}

const handoffRef = "refs/pi-subagent/handoffs/run_aaaa/attempt_bbbb";

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

	it("binds a workspace that starts at a hand-off of HEAD", async () => {
		const root = await repository("start-at");
		const head = await git(root, "rev-parse", "HEAD");
		const startAt = await commitOn(root, head, "handoff\n", handoffRef);
		const plain = await preflightWorkspace({ mode: "worktree", cwd: root });
		const started = await preflightWorkspace({
			mode: "worktree",
			cwd: root,
			startAt,
		});
		expect(started.startAt).toBe(startAt);
		expect(started.head).toBe(head);
		expect(plain.startAt).toBeUndefined();
		expect(started.baselineSha256).not.toBe(plain.baselineSha256);
	});

	it("refuses a startAt commit the repository does not hold", async () => {
		const root = await repository("start-at-missing");
		await expect(
			preflightWorkspace({
				mode: "read-only",
				cwd: root,
				startAt: "0".repeat(40),
			}),
		).rejects.toThrow(
			"workspace startAt commit does not exist in the repository",
		);
	});

	it("refuses a startAt commit no hand-off ref points at", async () => {
		const root = await repository("start-at-unpinned");
		const head = await git(root, "rev-parse", "HEAD");
		const startAt = await commitOn(root, head, "loose\n");
		await git(root, "update-ref", "refs/heads/elsewhere", startAt);
		await git(
			root,
			"update-ref",
			"refs/pi-subagent/handoffs/not-a-run/attempt_bbbb",
			startAt,
		);
		await expect(
			preflightWorkspace({ mode: "worktree", cwd: root, startAt }),
		).rejects.toThrow(
			"workspace startAt is not the target of a hand-off ref in this repository",
		);
	});

	it("refuses a hand-off whose parent is not HEAD", async () => {
		const root = await repository("start-at-stale");
		const head = await git(root, "rev-parse", "HEAD");
		const first = await commitOn(root, head, "first\n", handoffRef);
		const chained = await commitOn(
			root,
			first,
			"second\n",
			"refs/pi-subagent/handoffs/run_aaaa/attempt_cccc",
		);
		await expect(
			preflightWorkspace({ mode: "worktree", cwd: root, startAt: chained }),
		).rejects.toThrow(
			"workspace startAt must have exactly one parent, the repository HEAD",
		);
		await writeFile(path.join(root, "src", "next.ts"), "next\n");
		await git(root, "add", ".");
		await git(root, "commit", "--quiet", "-m", "moved on");
		await expect(
			preflightWorkspace({ mode: "read-only", cwd: root, startAt: first }),
		).rejects.toThrow(
			"workspace startAt must have exactly one parent, the repository HEAD",
		);
	});
});
