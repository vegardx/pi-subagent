import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	access,
	chmod,
	mkdir,
	readFile,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { acquireRunLease } from "../src/persistence/run-lease.js";
import { preflightWorkspace } from "../src/preflight/workspace.js";
import {
	captureWorktreeHandoff,
	createAttemptWorktree,
	exportWorktreeHandoff,
	finalizeWorktreeHandoff,
	handoffRefName,
	handoffRefTarget,
	inspectHandoffRef,
	MAX_HANDOFF_EXPORT_BYTES,
	observeWorktree,
	readWorktreeRecord,
	releaseWorktreeBranch,
	removeCleanWorktree,
	removeHandoffRef,
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
		const hookSentinel = path.join(repositoryRoot, "hook-fired");
		await writeFile(
			path.join(repositoryRoot, ".git", "hooks", "pre-commit"),
			`#!/bin/sh\nprintf hook > ${JSON.stringify(hookSentinel)}\n`,
			{ mode: 0o755 },
		);
		const sourceHead = await git(repositoryRoot, "rev-parse", "HEAD");
		const workspace = await preflightWorkspace({
			mode: "worktree",
			cwd: repositoryRoot,
		});
		const managerRoot = fixture("manager");
		const lease = await acquireRunLease({
			root: path.join(managerRoot, "leases"),
			runId: "run_handoff",
		});
		const record = await createAttemptWorktree({
			root: managerRoot,
			runId: "run_handoff",
			attemptId: "attempt_handoff",
			workspace,
			lease,
		});
		expect(await observeWorktree(record)).toMatchObject({ state: "clean" });
		await writeFile(path.join(record.worktreePath, "file.txt"), "changed\n");
		expect(await observeWorktree(record)).toMatchObject({ state: "dirty" });
		const handoff = await captureWorktreeHandoff(
			record,
			"test: capture handoff",
			lease,
		);
		expect(handoff.handoffCommit).toMatch(/^[a-f0-9]{40,64}$/);
		expect(handoff.handoffCommit).not.toBe(sourceHead);
		expect(await missing(hookSentinel)).toBe(true);
		expect(await git(repositoryRoot, "rev-parse", "HEAD")).toBe(sourceHead);
		expect(await readFile(path.join(repositoryRoot, "file.txt"), "utf8")).toBe(
			"baseline\n",
		);
		expect((await readWorktreeRecord(record.recordPath)).handoffCommit).toBe(
			handoff.handoffCommit,
		);
		await lease.release();
		const replacement = await acquireRunLease({
			root: path.join(managerRoot, "leases"),
			runId: "run_handoff",
		});
		await expect(removeCleanWorktree(handoff, lease)).rejects.toMatchObject({
			name: "RunLeaseFencedError",
		});
		await removeCleanWorktree(handoff, replacement);
		expect(await missing(record.worktreePath)).toBe(true);
		expect(await observeWorktree(handoff)).toMatchObject({
			state: "branch-retained",
		});
		expect(await git(repositoryRoot, "rev-parse", handoff.branch)).toBe(
			handoff.handoffCommit,
		);
		const released = await releaseWorktreeBranch(handoff, replacement);
		expect(released.releasedAt).toBeDefined();
		expect((await readWorktreeRecord(record.recordPath)).releasedAt).toBe(
			released.releasedAt,
		);
		expect(await observeWorktree(released)).toMatchObject({ state: "absent" });
		await expect(
			execFileAsync("git", ["rev-parse", "--verify", handoff.branch], {
				cwd: repositoryRoot,
			}),
		).rejects.toBeDefined();
		expect(handoff.handoffRef).toBe(
			handoffRefName("run_handoff", "attempt_handoff"),
		);
		expect(
			await git(
				repositoryRoot,
				"show-ref",
				"--verify",
				"--hash",
				handoff.handoffRef ?? "",
			),
		).toBe(handoff.handoffCommit);
		await replacement.release();
	});

	it("releases a clean unchanged worktree branch", async () => {
		const repositoryRoot = await repository("unchanged");
		const workspace = await preflightWorkspace({
			mode: "worktree",
			cwd: repositoryRoot,
		});
		const managerRoot = fixture("manager-unchanged");
		const lease = await acquireRunLease({
			root: path.join(managerRoot, "leases"),
			runId: "run_unchanged",
		});
		const record = await createAttemptWorktree({
			root: managerRoot,
			runId: "run_unchanged",
			attemptId: "attempt_unchanged",
			workspace,
			lease,
		});
		expect(
			await finalizeWorktreeHandoff(record, "test: no-op handoff", lease),
		).toBeUndefined();
		const released = await releaseWorktreeBranch(record, lease);
		expect(released.releasedAt).toBeDefined();
		await expect(
			execFileAsync("git", ["rev-parse", "--verify", record.branch], {
				cwd: repositoryRoot,
			}),
		).rejects.toBeDefined();
		await lease.release();
	});

	it("retains dirty work and rejects duplicate attempt reservations", async () => {
		const repositoryRoot = await repository("retained");
		const workspace = await preflightWorkspace({
			mode: "worktree",
			cwd: repositoryRoot,
		});
		const managerRoot = fixture("manager-retained");
		const lease = await acquireRunLease({
			root: path.join(managerRoot, "leases"),
			runId: "run_retained",
		});
		const record = await createAttemptWorktree({
			root: managerRoot,
			runId: "run_retained",
			attemptId: "attempt_retained",
			workspace,
			lease,
		});
		await expect(
			createAttemptWorktree({
				root: managerRoot,
				runId: "run_retained",
				attemptId: "attempt_retained",
				workspace,
				lease,
			}),
		).rejects.toThrow("already reserved");
		await writeFile(
			path.join(record.worktreePath, "uncommitted.txt"),
			"keep\n",
		);
		await expect(removeCleanWorktree(record, lease)).rejects.toBeInstanceOf(
			WorktreeError,
		);
		expect(await missing(record.worktreePath)).toBe(false);
		await lease.release();
	});
});

describe("handoff export", () => {
	async function fixtureWithHandoff(name: string) {
		const repositoryRoot = await repository(name);
		await writeFile(path.join(repositoryRoot, "renamed-old.txt"), "moved\n");
		await writeFile(path.join(repositoryRoot, "deleted.txt"), "gone\n");
		await writeFile(path.join(repositoryRoot, "script.sh"), "#!/bin/sh\n");
		await writeFile(
			path.join(repositoryRoot, "context.txt"),
			"alpha\n\nbeta\n\ngamma\n",
		);
		await writeFile(
			path.join(repositoryRoot, "blob.bin"),
			Buffer.from([0, 1, 2, 3, 255, 254, 10, 13, 0]),
		);
		await git(repositoryRoot, "add", ".");
		await git(repositoryRoot, "commit", "--quiet", "-m", "fixture");
		const workspace = await preflightWorkspace({
			mode: "worktree",
			cwd: repositoryRoot,
		});
		const managerRoot = fixture(`${name}-manager`);
		const runId = `run_${name.replaceAll(/[^a-z0-9]/g, "")}`;
		const attemptId = `attempt_${name.replaceAll(/[^a-z0-9]/g, "")}`;
		const lease = await acquireRunLease({
			root: path.join(managerRoot, "leases"),
			runId,
		});
		const record = await createAttemptWorktree({
			root: managerRoot,
			runId,
			attemptId,
			workspace,
			lease,
		});
		const tree = record.worktreePath;
		await writeFile(path.join(tree, "file.txt"), "text changed\nsecond\n");
		await writeFile(path.join(tree, "context.txt"), "alpha\n\nbeta\n\ndelta\n");
		await writeFile(
			path.join(tree, "blob.bin"),
			Buffer.from([9, 8, 7, 0, 0, 200, 201, 10, 13, 26, 0, 0, 0]),
		);
		await writeFile(
			path.join(tree, "new.bin"),
			Buffer.concat([Buffer.alloc(300, 0), Buffer.from([1, 2, 3])]),
		);
		await chmod(path.join(tree, "script.sh"), 0o755);
		await symlink("file.txt", path.join(tree, "link"));
		await rename(
			path.join(tree, "renamed-old.txt"),
			path.join(tree, "renamed-new.txt"),
		);
		await rm(path.join(tree, "deleted.txt"));
		const handoff = await captureWorktreeHandoff(
			record,
			"test: mixed handoff",
			lease,
		);
		await removeCleanWorktree(handoff, lease);
		return { repositoryRoot, handoff, lease, runId, attemptId, managerRoot };
	}

	it("exports a deterministic binary-safe patch that reproduces the handoff tree", async () => {
		const data = await fixtureWithHandoff("fidelity");
		const first = await exportWorktreeHandoff(data.handoff, {
			lease: data.lease,
		});
		const second = await exportWorktreeHandoff(data.handoff, {
			lease: data.lease,
		});
		expect(first.ref).toEqual({
			runId: data.runId,
			attemptId: data.attemptId,
			baselineHead: data.handoff.baselineHead,
			handoffCommit: data.handoff.handoffCommit,
			format: "git-format-patch",
			sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
			bytes: first.content.byteLength,
			mediaType: "application/x-git-format-patch",
		});
		expect(second.ref).toEqual(first.ref);
		expect(second.content.equals(first.content)).toBe(true);
		await git(data.repositoryRoot, "config", "diff.suppressBlankEmpty", "true");
		await git(
			data.repositoryRoot,
			"replace",
			data.handoff.handoffCommit ?? "",
			data.handoff.baselineHead,
		);
		const third = await exportWorktreeHandoff(data.handoff, {
			lease: data.lease,
		});
		expect(third.ref).toEqual(first.ref);
		expect(third.content.equals(first.content)).toBe(true);
		await git(
			data.repositoryRoot,
			"replace",
			"-d",
			data.handoff.handoffCommit ?? "",
		);
		await git(
			data.repositoryRoot,
			"config",
			"--unset",
			"diff.suppressBlankEmpty",
		);
		const text = first.content.toString("utf8");
		expect(text).toContain("\n \n");
		expect(text.startsWith(`From ${data.handoff.handoffCommit} `)).toBe(true);
		expect(text).toContain("GIT binary patch");
		expect(text).toContain("old mode 100644\nnew mode 100755");
		expect(text).toContain("rename from renamed-old.txt");
		expect(text).toContain("deleted file mode 100644");
		expect(text).toContain("new file mode 120000");
		expect(text).not.toMatch(/\n-- \n\d/);
		const clone = fixture("fidelity-clone");
		await git(tmpdir(), "clone", "--quiet", data.repositoryRoot, clone);
		await git(clone, "checkout", "--quiet", data.handoff.baselineHead);
		const patchPath = path.join(clone, "..", `${path.basename(clone)}.patch`);
		await writeFile(patchPath, first.content);
		await execFileAsync("git", ["am", "--quiet", patchPath], {
			cwd: clone,
			env: {
				...process.env,
				GIT_COMMITTER_NAME: "Importer",
				GIT_COMMITTER_EMAIL: "importer@example.invalid",
			},
		});
		expect(await git(clone, "rev-parse", "HEAD^{tree}")).toBe(
			await git(
				data.repositoryRoot,
				"rev-parse",
				`${data.handoff.handoffCommit}^{tree}`,
			),
		);
		await data.lease.release();
	});

	it("bounds export bytes and refuses records without an exportable handoff", async () => {
		const data = await fixtureWithHandoff("bounds");
		const exported = await exportWorktreeHandoff(data.handoff, {
			lease: data.lease,
			maxBytes: MAX_HANDOFF_EXPORT_BYTES,
		});
		await expect(
			exportWorktreeHandoff(data.handoff, {
				lease: data.lease,
				maxBytes: exported.ref.bytes,
			}),
		).resolves.toMatchObject({ ref: exported.ref });
		await expect(
			exportWorktreeHandoff(data.handoff, {
				lease: data.lease,
				maxBytes: exported.ref.bytes - 1,
			}),
		).rejects.toThrow("handoff export exceeds byte limit");
		await expect(
			exportWorktreeHandoff(data.handoff, {
				lease: data.lease,
				maxBytes: MAX_HANDOFF_EXPORT_BYTES + 1,
			}),
		).rejects.toThrow("handoff export limit");
		const {
			handoffCommit: _commit,
			handoffRef: _ref,
			...noHandoff
		} = data.handoff;
		await expect(
			exportWorktreeHandoff(noHandoff, { lease: data.lease }),
		).rejects.toThrow("no handoff commit to export");
		const emptyRef = handoffRefName(data.runId, "attempt_empty");
		await git(
			data.repositoryRoot,
			"update-ref",
			emptyRef,
			data.handoff.baselineHead,
		);
		await expect(
			exportWorktreeHandoff(
				{
					...data.handoff,
					attemptId: "attempt_empty",
					handoffCommit: data.handoff.baselineHead,
					handoffRef: emptyRef,
				},
				{ lease: data.lease },
			),
		).rejects.toThrow("equals its baseline");
		const side = fixture("bounds-side");
		await git(
			data.repositoryRoot,
			"worktree",
			"add",
			"--quiet",
			"--detach",
			side,
			data.handoff.baselineHead,
		);
		await writeFile(path.join(side, "side.txt"), "side\n");
		await git(side, "add", ".");
		await git(side, "commit", "--quiet", "-m", "side");
		const sideCommit = await git(side, "rev-parse", "HEAD");
		await git(side, "checkout", "--quiet", data.handoff.baselineHead);
		await git(side, "merge", "--no-ff", "--quiet", "-m", "merge", sideCommit);
		const mergeCommit = await git(side, "rev-parse", "HEAD");
		expect(await git(side, "rev-parse", `${mergeCommit}^1`)).toBe(
			data.handoff.baselineHead,
		);
		const mergeRef = handoffRefName(data.runId, "attempt_merge");
		await git(data.repositoryRoot, "update-ref", mergeRef, mergeCommit);
		await expect(
			exportWorktreeHandoff(
				{
					...data.handoff,
					attemptId: "attempt_merge",
					handoffCommit: mergeCommit,
					handoffRef: mergeRef,
				},
				{ lease: data.lease },
			),
		).rejects.toThrow("exactly one parent");
		await expect(
			inspectHandoffRef({
				runId: data.runId,
				repositoryRoot: await (async () => {
					const plain = fixture("bounds-plain");
					await mkdir(plain, { recursive: true });
					return plain;
				})(),
				ref: mergeRef,
				commit: mergeCommit,
			}),
		).rejects.toThrow("handoff ref lookup failed");
		await data.lease.release();
		const replacement = await acquireRunLease({
			root: path.join(data.managerRoot, "leases"),
			runId: data.runId,
		});
		await expect(
			exportWorktreeHandoff(data.handoff, { lease: data.lease }),
		).rejects.toMatchObject({ name: "RunLeaseFencedError" });
		await replacement.release();
	});

	it("keeps the handoff reachable after release until the ref is removed", async () => {
		const data = await fixtureWithHandoff("reachable");
		const released = await releaseWorktreeBranch(data.handoff, data.lease);
		expect(released.releasedAt).toBeDefined();
		await expect(
			execFileAsync("git", ["rev-parse", "--verify", released.branch], {
				cwd: data.repositoryRoot,
			}),
		).rejects.toBeDefined();
		const target = handoffRefTarget(released);
		if (!target) throw new Error("handoff ref target missing");
		expect(await inspectHandoffRef(target)).toBe("present");
		const exported = await exportWorktreeHandoff(released, {
			lease: data.lease,
		});
		expect(exported.ref.handoffCommit).toBe(data.handoff.handoffCommit);
		await git(data.repositoryRoot, "gc", "--quiet", "--prune=now");
		expect(
			await git(
				data.repositoryRoot,
				"cat-file",
				"-t",
				data.handoff.handoffCommit ?? "",
			),
		).toBe("commit");
		expect(await removeHandoffRef(target, data.lease)).toBe("present");
		expect(await inspectHandoffRef(target)).toBe("absent");
		expect(await removeHandoffRef(target, data.lease)).toBe("absent");
		await expect(
			exportWorktreeHandoff(released, { lease: data.lease }),
		).rejects.toThrow("not reachable");
		await expect(
			inspectHandoffRef({ ...target, repositoryRoot: fixture("missing") }),
		).resolves.toBe("repository-missing");
		await data.lease.release();
	});

	it("refuses capture while a foreign ref occupies the attempt's handoff name", async () => {
		const repositoryRoot = await repository("foreign-ref");
		const workspace = await preflightWorkspace({
			mode: "worktree",
			cwd: repositoryRoot,
		});
		const managerRoot = fixture("foreign-ref-manager");
		const lease = await acquireRunLease({
			root: path.join(managerRoot, "leases"),
			runId: "run_foreign",
		});
		const record = await createAttemptWorktree({
			root: managerRoot,
			runId: "run_foreign",
			attemptId: "attempt_foreign",
			workspace,
			lease,
		});
		await writeFile(path.join(record.worktreePath, "file.txt"), "changed\n");
		const ref = handoffRefName("run_foreign", "attempt_foreign");
		await git(repositoryRoot, "update-ref", ref, record.baselineHead);
		await expect(
			captureWorktreeHandoff(record, "test: foreign", lease),
		).rejects.toThrow("handoff ref already exists");
		expect(await git(record.worktreePath, "rev-parse", "HEAD")).toBe(
			record.baselineHead,
		);
		expect(await observeWorktree(record)).toMatchObject({ state: "dirty" });
		await git(repositoryRoot, "update-ref", "-d", ref);
		const handoff = await captureWorktreeHandoff(record, "test: retry", lease);
		expect(handoff.handoffRef).toBe(ref);
		expect(
			await git(repositoryRoot, "show-ref", "--verify", "--hash", ref),
		).toBe(handoff.handoffCommit);
		await lease.release();
	});

	it("refuses to release a branch whose handoff has no durable ref", async () => {
		const data = await fixtureWithHandoff("unreachable");
		await git(
			data.repositoryRoot,
			"update-ref",
			"-d",
			data.handoff.handoffRef ?? "",
		);
		await expect(
			releaseWorktreeBranch(data.handoff, data.lease),
		).rejects.toThrow("not reachable");
		expect(
			await git(data.repositoryRoot, "rev-parse", data.handoff.branch),
		).toBe(data.handoff.handoffCommit);
		await data.lease.release();
	});
});
