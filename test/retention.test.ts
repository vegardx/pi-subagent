import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { CONTRACT_REVISION } from "../src/contracts.js";
import {
	createRetentionManager,
	type RetentionRun,
} from "../src/persistence/retention.js";
import { acquireRunLease } from "../src/persistence/run-lease.js";
import {
	handoffRefName,
	type WorktreeRecord,
} from "../src/workspace/worktree.js";

const execFileAsync = promisify(execFile);
const old = "2026-01-01T00:00:00.000Z";

async function git(cwd: string, ...args: string[]): Promise<string> {
	return (await execFileAsync("git", args, { cwd })).stdout.trim();
}

async function handoffRepository(
	root: string,
	runId: string,
	attemptId: string,
	omit: "none" | "ref" | "ref-and-commit" = "none",
) {
	const repositoryRoot = path.join(root, "..", `repository-${randomUUID()}`);
	await mkdir(repositoryRoot, { recursive: true });
	await git(repositoryRoot, "init", "--quiet");
	await git(repositoryRoot, "config", "user.name", "Qualification");
	await git(repositoryRoot, "config", "user.email", "q@example.invalid");
	await writeFile(path.join(repositoryRoot, "file.txt"), "baseline\n");
	await git(repositoryRoot, "add", ".");
	await git(repositoryRoot, "commit", "--quiet", "-m", "baseline");
	const baselineHead = await git(repositoryRoot, "rev-parse", "HEAD");
	await writeFile(path.join(repositoryRoot, "file.txt"), "handoff\n");
	await git(repositoryRoot, "commit", "--quiet", "-am", "handoff");
	const handoffCommit = await git(repositoryRoot, "rev-parse", "HEAD");
	await git(repositoryRoot, "reset", "--quiet", "--hard", baselineHead);
	const handoffRef = handoffRefName(runId, attemptId);
	await git(repositoryRoot, "update-ref", handoffRef, handoffCommit);
	const recordPath = path.join(
		root,
		"workspace",
		"records",
		`${attemptId}.json`,
	);
	const record: WorktreeRecord = {
		schema: "pi-subagent-worktree",
		contractRevision: CONTRACT_REVISION,
		runId,
		attemptId,
		repositoryRoot,
		worktreePath: path.join(root, "workspace", "worktrees", attemptId),
		recordPath,
		branch: `pi-subagent/${runId}/${attemptId}`,
		baselineHead,
		createdAt: old,
		...(omit === "ref-and-commit" ? {} : { handoffCommit }),
		...(omit === "none" ? { handoffRef } : {}),
		releasedAt: old,
	};
	await mkdir(path.dirname(recordPath), { recursive: true });
	await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);
	return { repositoryRoot, record };
}
const now = new Date("2026-03-01T00:00:00.000Z");

async function fixture() {
	const base = path.join(tmpdir(), `pi-subagent-retention-${randomUUID()}`);
	const root = path.join(base, "service");
	await mkdir(root, { recursive: true });
	return {
		root,
		manager: await createRetentionManager({
			root,
			trashRoot: path.join(base, "trash"),
		}),
	};
}

async function addRun(root: string, runId: string, bytes = 64) {
	const attemptId = `attempt_${runId.slice(4)}`;
	const runDirectory = path.join(root, "runs", runId);
	await mkdir(runDirectory, { recursive: true });
	await writeFile(path.join(runDirectory, "run.json"), "x".repeat(bytes));
	await mkdir(path.join(root, "run-records"), { recursive: true });
	await writeFile(path.join(root, "run-records", `${runId}.json`), "record");
	await mkdir(path.join(root, "attempt-records", runId), { recursive: true });
	await writeFile(
		path.join(root, "attempt-records", runId, `${attemptId}.json`),
		"attempt",
	);
	await mkdir(path.join(root, "sessions", attemptId), { recursive: true });
	await writeFile(path.join(root, "sessions", attemptId, "session.jsonl"), "s");
	await mkdir(path.join(root, "operations"), { recursive: true });
	await writeFile(
		path.join(root, "operations", `${runId}.json`),
		JSON.stringify({
			schema: "pi-subagent-operation",
			contractRevision: CONTRACT_REVISION,
			ownerId: "owner",
			operationId: `operation-${runId}`,
			requestSha256: "a".repeat(64),
			runId,
			createdAt: old,
		}),
	);
	return attemptId;
}

function descriptor(
	runId: string,
	attemptId: string,
	overrides: Partial<RetentionRun> = {},
): RetentionRun {
	return {
		runId,
		status: "completed",
		terminalAt: old,
		attemptIds: [attemptId],
		worktreeAttemptIds: [attemptId],
		retainedWorktree: false,
		...overrides,
	};
}

describe("retention and pruning", () => {
	it("protects pins, interrupted runs, and retained worktrees", async () => {
		const data = await fixture();
		const ids = [
			"run_old",
			"run_abandoned",
			"run_pin",
			"run_interrupt",
			"run_worktree",
		];
		const attempts = new Map<string, string>();
		for (const id of ids) attempts.set(id, await addRun(data.root, id));
		await data.manager.pin("owner", "run_pin", "keep for review");
		const report = await data.manager.prune({
			runs: [
				descriptor("run_old", attempts.get("run_old") ?? ""),
				descriptor("run_abandoned", attempts.get("run_abandoned") ?? "", {
					status: "abandoned",
				}),
				descriptor("run_pin", attempts.get("run_pin") ?? ""),
				descriptor("run_interrupt", attempts.get("run_interrupt") ?? "", {
					status: "interrupted",
				}),
				descriptor("run_worktree", attempts.get("run_worktree") ?? "", {
					retainedWorktree: true,
				}),
			],
			dryRun: true,
			now,
		});
		expect(report.selected.map((run) => run.runId)).toEqual([
			"run_abandoned",
			"run_old",
		]);
		expect(
			report.protected.find((run) => run.runId === "run_pin")?.reasons,
		).toContain("pinned");
		expect(
			report.protected.find((run) => run.runId === "run_interrupt")?.reasons,
		).toContain("status:interrupted");
		expect(
			report.protected.find((run) => run.runId === "run_worktree")?.reasons,
		).toContain("retained-worktree");
		expect(
			await readFile(
				path.join(data.root, "runs", "run_old", "run.json"),
				"utf8",
			),
		).toBeTruthy();
	});

	it("evicts the oldest ordinary run to enforce the byte budget", async () => {
		const data = await fixture();
		const olderAttempt = await addRun(data.root, "run_older", 200);
		const newerAttempt = await addRun(data.root, "run_newer", 200);
		const runs = [
			descriptor("run_older", olderAttempt, {
				terminalAt: "2026-02-27T00:00:00.000Z",
			}),
			descriptor("run_newer", newerAttempt, {
				terminalAt: "2026-02-28T00:00:00.000Z",
			}),
		];
		const assessment = await data.manager.prune({
			runs,
			dryRun: true,
			now,
			maxAgeMs: 30 * 24 * 60 * 60 * 1000,
			maxBytes: Number.MAX_SAFE_INTEGER,
		});
		const budget = assessment.ordinaryBytesBefore - 1;
		const report = await data.manager.prune({
			runs,
			dryRun: true,
			now,
			maxAgeMs: 30 * 24 * 60 * 60 * 1000,
			maxBytes: budget,
		});
		expect(report.selected[0]?.runId).toBe("run_older");
		expect(report.selected[0]?.reasons).toContain("budget");
		expect(report.ordinaryBytesAfter).toBeLessThanOrEqual(budget);
	});

	it("moves the complete linked run graph to recoverable trash", async () => {
		const data = await fixture();
		const attemptId = await addRun(data.root, "run_prune");
		const sharedWorktreeAttemptId = "attempt_sharedworktree";
		const handoff = await handoffRepository(
			data.root,
			"run_prune",
			sharedWorktreeAttemptId,
		);
		const dryRun = await data.manager.prune({
			runs: [
				descriptor("run_prune", attemptId, {
					worktreeAttemptIds: [sharedWorktreeAttemptId],
				}),
			],
			dryRun: true,
			now,
		});
		expect(dryRun.selected.map((run) => run.runId)).toEqual(["run_prune"]);
		expect(
			await git(
				handoff.repositoryRoot,
				"show-ref",
				"--verify",
				"--hash",
				handoff.record.handoffRef ?? "",
			),
		).toBe(handoff.record.handoffCommit);
		const report = await data.manager.prune({
			runs: [
				descriptor("run_prune", attemptId, {
					worktreeAttemptIds: [sharedWorktreeAttemptId],
				}),
			],
			dryRun: false,
			now,
		});
		const pruned = report.pruned[0];
		expect(pruned?.runId).toBe("run_prune");
		if (!pruned?.trashPath) throw new Error("trash path missing");
		await expect(
			stat(path.join(data.root, "runs", "run_prune")),
		).rejects.toMatchObject({ code: "ENOENT" });
		await expect(
			stat(path.join(data.root, "leases", "run_prune.lease.json")),
		).rejects.toMatchObject({ code: "ENOENT" });
		expect(
			await readFile(path.join(pruned.trashPath, "manifest.json"), "utf8"),
		).toContain("run-records/run_prune.json");
		expect(
			await readFile(path.join(pruned.trashPath, "completed.json"), "utf8"),
		).toContain("run_prune");
		expect(
			await readFile(
				path.join(pruned.trashPath, "sessions", attemptId, "session.jsonl"),
				"utf8",
			),
		).toBe("s");
		expect(
			JSON.parse(
				await readFile(
					path.join(
						pruned.trashPath,
						"workspace",
						"records",
						`${sharedWorktreeAttemptId}.json`,
					),
					"utf8",
				),
			),
		).toEqual(handoff.record);
		expect(
			JSON.parse(
				await readFile(path.join(pruned.trashPath, "manifest.json"), "utf8"),
			).handoffRefs,
		).toEqual([
			{
				runId: "run_prune",
				repositoryRoot: handoff.repositoryRoot,
				ref: handoff.record.handoffRef,
				commit: handoff.record.handoffCommit,
			},
		]);
		await expect(
			git(
				handoff.repositoryRoot,
				"show-ref",
				"--verify",
				"--quiet",
				handoff.record.handoffRef ?? "",
			),
		).rejects.toBeDefined();
		expect(
			await git(
				handoff.repositoryRoot,
				"cat-file",
				"-t",
				handoff.record.handoffCommit ?? "",
			),
		).toBe("commit");
		expect(
			await readFile(
				path.join(pruned.trashPath, "operations", "run_prune.json"),
				"utf8",
			),
		).toContain("operation-run_prune");
	});

	it("reclaims deterministic handoff refs the record never learned about", async () => {
		const data = await fixture();
		const missingRef = await addRun(data.root, "run_missingref");
		const missingBoth = await addRun(data.root, "run_missingboth");
		const first = await handoffRepository(
			data.root,
			"run_missingref",
			missingRef,
			"ref",
		);
		const second = await handoffRepository(
			data.root,
			"run_missingboth",
			missingBoth,
			"ref-and-commit",
		);
		const report = await data.manager.prune({
			runs: [
				descriptor("run_missingref", missingRef),
				descriptor("run_missingboth", missingBoth),
			],
			dryRun: false,
			now,
		});
		expect(report.pruned.map((run) => run.runId).sort()).toEqual([
			"run_missingboth",
			"run_missingref",
		]);
		for (const [repo, runId, attemptId] of [
			[first.repositoryRoot, "run_missingref", missingRef],
			[second.repositoryRoot, "run_missingboth", missingBoth],
		] as const) {
			await expect(
				git(
					repo,
					"show-ref",
					"--verify",
					"--quiet",
					handoffRefName(runId, attemptId),
				),
			).rejects.toBeDefined();
		}
		const manifest = JSON.parse(
			await readFile(
				path.join(
					report.pruned.find((run) => run.runId === "run_missingboth")
						?.trashPath ?? "",
					"manifest.json",
				),
				"utf8",
			),
		);
		expect(manifest.handoffRefs).toEqual([
			{
				runId: "run_missingboth",
				repositoryRoot: second.repositoryRoot,
				ref: handoffRefName("run_missingboth", missingBoth),
			},
		]);
	});

	it("protects a run whose handoff repository cannot be inspected", async () => {
		const data = await fixture();
		const attemptId = await addRun(data.root, "run_corruptrefs");
		const handoff = await handoffRepository(
			data.root,
			"run_corruptrefs",
			attemptId,
		);
		await git(handoff.repositoryRoot, "pack-refs", "--all");
		await writeFile(
			path.join(handoff.repositoryRoot, ".git", "packed-refs"),
			"garbage without newline",
		);
		const report = await data.manager.prune({
			runs: [descriptor("run_corruptrefs", attemptId)],
			dryRun: false,
			now,
		});
		expect(report.pruned).toEqual([]);
		expect(report.protected[0]?.reasons).toEqual(["handoff-ref-unremovable"]);
		expect(
			await readFile(
				path.join(data.root, "run-records", "run_corruptrefs.json"),
				"utf8",
			),
		).toBe("record");
	});

	it("protects a run whose handoff ref cannot be removed safely", async () => {
		const data = await fixture();
		const attemptId = await addRun(data.root, "run_refdrift");
		const handoff = await handoffRepository(
			data.root,
			"run_refdrift",
			attemptId,
		);
		await git(
			handoff.repositoryRoot,
			"update-ref",
			handoff.record.handoffRef ?? "",
			handoff.record.baselineHead,
		);
		const report = await data.manager.prune({
			runs: [descriptor("run_refdrift", attemptId)],
			dryRun: false,
			now,
		});
		expect(report.pruned).toEqual([]);
		expect(report.protected[0]?.reasons).toEqual(["handoff-ref-unremovable"]);
		expect(
			await readFile(
				path.join(data.root, "run-records", "run_refdrift.json"),
				"utf8",
			),
		).toBe("record");
		await mkdir(path.join(data.root, "workspace", "records"), {
			recursive: true,
		});
		const invalidAttempt = await addRun(data.root, "run_invalidrecord");
		await writeFile(
			path.join(data.root, "workspace", "records", `${invalidAttempt}.json`),
			"not a worktree record",
		);
		await expect(
			data.manager.prune({
				runs: [descriptor("run_invalidrecord", invalidAttempt)],
				dryRun: false,
				now,
			}),
		).rejects.toThrow("invalid worktree record during retention");
	});

	it("protects a selected run whose run lease is live", async () => {
		const data = await fixture();
		const attemptId = await addRun(data.root, "run_live");
		const lease = await acquireRunLease({
			root: path.join(data.root, "leases"),
			runId: "run_live",
		});
		try {
			const report = await data.manager.prune({
				runs: [descriptor("run_live", attemptId)],
				dryRun: false,
				now,
			});
			expect(report.pruned).toEqual([]);
			expect(report.protected[0]?.reasons).toEqual(["run-lease-unavailable"]);
			expect(
				await readFile(
					path.join(data.root, "runs", "run_live", "run.json"),
					"utf8",
				),
			).toBeTruthy();
		} finally {
			await lease.release();
		}
	});

	it("rejects malformed linked-path descriptors before filesystem traversal", async () => {
		const data = await fixture();
		await expect(
			data.manager.prune({
				runs: [
					{
						runId: "run_valid",
						status: "completed",
						terminalAt: old,
						attemptIds: ["../../outside"],
						worktreeAttemptIds: [],
						retainedWorktree: false,
					},
				],
				dryRun: true,
				now,
			}),
		).rejects.toThrow("invalid retention run descriptor");
	});

	it("resumes an incomplete recoverable-trash move before pruning", async () => {
		const data = await fixture();
		const runId = "run_partial";
		const attemptId = await addRun(data.root, runId);
		const handoff = await handoffRepository(data.root, runId, attemptId);
		const trashPath = path.join(data.manager.trashRoot, "partial-intent");
		const relativePaths = [
			path.join("runs", runId),
			path.join("run-records", `${runId}.json`),
			path.join("attempt-records", runId),
			path.join("leases", `${runId}.lease.json`),
			path.join("sessions", attemptId),
			path.join("operations", `${runId}.json`),
			path.join("workspace", "records", `${attemptId}.json`),
		];
		await mkdir(path.join(trashPath, "runs"), { recursive: true });
		await rename(
			path.join(data.root, "runs", runId),
			path.join(trashPath, "runs", runId),
		);
		await writeFile(
			path.join(trashPath, "manifest.json"),
			JSON.stringify({
				schema: "pi-subagent-retention-trash",
				contractRevision: CONTRACT_REVISION,
				runId,
				createdAt: old,
				commitPath: path.join("run-records", `${runId}.json`),
				paths: relativePaths,
				handoffRefs: [
					{
						runId,
						repositoryRoot: handoff.repositoryRoot,
						ref: handoff.record.handoffRef,
						commit: handoff.record.handoffCommit,
					},
				],
			}),
		);
		const report = await data.manager.prune({
			runs: [descriptor(runId, attemptId)],
			dryRun: false,
			now,
		});
		expect(report.recoveredTrashIntents).toEqual([runId]);
		await expect(
			git(
				handoff.repositoryRoot,
				"show-ref",
				"--verify",
				"--quiet",
				handoff.record.handoffRef ?? "",
			),
		).rejects.toBeDefined();
		expect(
			await readFile(path.join(trashPath, "completed.json"), "utf8"),
		).toContain(runId);
		await expect(
			stat(path.join(data.root, "run-records", `${runId}.json`)),
		).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("pins idempotently and moves removed pins to trash", async () => {
		const data = await fixture();
		await addRun(data.root, "run_pin");
		const first = await data.manager.pin("owner", "run_pin", "keep");
		const duplicate = await data.manager.pin("owner", "run_pin", "keep");
		expect(duplicate).toEqual(first);
		await expect(
			data.manager.pin("owner", "run_pin", "different"),
		).rejects.toThrow("conflicts");
		expect(await data.manager.unpin("owner", "run_pin")).toBe(true);
		expect(await data.manager.listPins("run_pin")).toEqual([]);
		expect(await data.manager.unpin("owner", "run_pin")).toBe(false);
	});
});
