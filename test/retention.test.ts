import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CONTRACT_REVISION } from "../src/contracts.js";
import {
	createRetentionManager,
	type RetentionRun,
} from "../src/persistence/retention.js";
import { acquireRunLease } from "../src/persistence/run-lease.js";

const old = "2026-01-01T00:00:00.000Z";
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
		const ids = ["run_old", "run_pin", "run_interrupt", "run_worktree"];
		const attempts = new Map<string, string>();
		for (const id of ids) attempts.set(id, await addRun(data.root, id));
		await data.manager.pin("owner", "run_pin", "keep for review");
		const report = await data.manager.prune({
			runs: [
				descriptor("run_old", attempts.get("run_old") ?? ""),
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
		expect(report.selected.map((run) => run.runId)).toEqual(["run_old"]);
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
		await mkdir(path.join(data.root, "workspace", "records"), {
			recursive: true,
		});
		await writeFile(
			path.join(
				data.root,
				"workspace",
				"records",
				`${sharedWorktreeAttemptId}.json`,
			),
			"shared worktree record",
		);
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
			await readFile(
				path.join(
					pruned.trashPath,
					"workspace",
					"records",
					`${sharedWorktreeAttemptId}.json`,
				),
				"utf8",
			),
		).toBe("shared worktree record");
		expect(
			await readFile(
				path.join(pruned.trashPath, "operations", "run_prune.json"),
				"utf8",
			),
		).toContain("operation-run_prune");
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
		const trashPath = path.join(data.manager.trashRoot, "partial-intent");
		const relativePaths = [
			path.join("runs", runId),
			path.join("run-records", `${runId}.json`),
			path.join("attempt-records", runId),
			path.join("leases", `${runId}.lease.json`),
			path.join("sessions", attemptId),
			path.join("operations", `${runId}.json`),
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
			}),
		);
		const report = await data.manager.prune({
			runs: [descriptor(runId, attemptId)],
			dryRun: false,
			now,
		});
		expect(report.recoveredTrashIntents).toEqual([runId]);
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
