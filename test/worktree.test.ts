import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { preflightWorkspace } from "../src/preflight/workspace.js";
import {
	captureWorktreeHandoff,
	createAttemptWorktree,
	readWorktreeRecord,
	removeCleanWorktree,
	WorktreeError,
} from "../src/workspace/worktree.js";

const execFileAsync = promisify(execFile);

function fixture(name: string): string {
	return path.join(tmpdir(), `pi-subagent-worktree-${name}-${randomUUID()}`);
}

async function git(cwd: string, ...args: string[]): Promise<string> {
	return (await execFileAsync("git", args, { cwd })).stdout.trim();
}

async function repository(name: string): Promise<string> {
	const root = fixture(name);
	await mkdir(root, { recursive: true });
	await git(root, "init", "--quiet");
	await git(root, "config", "user.name", "Qualification");
	await git(root, "config", "user.email", "qualification@example.invalid");
	await writeFile(path.join(root, "file.txt"), "baseline\n");
	await git(root, "add", ".");
	await git(root, "commit", "--quiet", "-m", "initial");
	return root;
}

async function missing(filePath: string): Promise<boolean> {
	try {
		await access(filePath);
		return false;
	} catch {
		return true;
	}
}

describe("worktree lifecycle", () => {
	it("captures an immutable commit before clean removal", async () => {
		const repositoryRoot = await repository("handoff");
		const sourceHead = await git(repositoryRoot, "rev-parse", "HEAD");
		const workspace = await preflightWorkspace({
			mode: "worktree",
			cwd: repositoryRoot,
		});
		const record = await createAttemptWorktree({
			root: fixture("manager"),
			runId: "run_handoff",
			attemptId: "attempt_handoff",
			workspace,
		});
		await writeFile(path.join(record.worktreePath, "file.txt"), "changed\n");
		const handoff = await captureWorktreeHandoff(
			record,
			"test: capture handoff",
		);
		expect(handoff.handoffCommit).toMatch(/^[a-f0-9]{40,64}$/);
		expect(handoff.handoffCommit).not.toBe(sourceHead);
		expect(await git(repositoryRoot, "rev-parse", "HEAD")).toBe(sourceHead);
		expect(await readFile(path.join(repositoryRoot, "file.txt"), "utf8")).toBe(
			"baseline\n",
		);
		expect((await readWorktreeRecord(record.recordPath)).handoffCommit).toBe(
			handoff.handoffCommit,
		);
		await removeCleanWorktree(handoff);
		expect(await missing(record.worktreePath)).toBe(true);
		expect(await git(repositoryRoot, "rev-parse", handoff.branch)).toBe(
			handoff.handoffCommit,
		);
	});

	it("retains dirty work and rejects duplicate attempt reservations", async () => {
		const repositoryRoot = await repository("retained");
		const workspace = await preflightWorkspace({
			mode: "worktree",
			cwd: repositoryRoot,
		});
		const managerRoot = fixture("manager-retained");
		const record = await createAttemptWorktree({
			root: managerRoot,
			runId: "run_retained",
			attemptId: "attempt_retained",
			workspace,
		});
		await expect(
			createAttemptWorktree({
				root: managerRoot,
				runId: "run_retained",
				attemptId: "attempt_retained",
				workspace,
			}),
		).rejects.toThrow("already reserved");
		await writeFile(
			path.join(record.worktreePath, "uncommitted.txt"),
			"keep\n",
		);
		await expect(removeCleanWorktree(record)).rejects.toBeInstanceOf(
			WorktreeError,
		);
		expect(await missing(record.worktreePath)).toBe(false);
	});
});
