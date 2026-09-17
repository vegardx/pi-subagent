import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { CONTRACT_REVISION } from "../src/contracts.js";
import { quarantineStaleState } from "../src/persistence/store-revision.js";
import { createVmCapacityManager } from "../src/sandbox/capacity.js";
import { createSubagentService } from "../src/service.js";

const hash = "a".repeat(64);
const STALE = CONTRACT_REVISION - 1;
const FUTURE = CONTRACT_REVISION + 1;

async function store(name: string): Promise<string> {
	const root = path.join(
		tmpdir(),
		`pi-subagent-store-revision-${name}-${randomUUID()}`,
		"state",
	);
	await mkdir(root, { recursive: true, mode: 0o700 });
	return root;
}

async function writeJson(
	file: string,
	value: Record<string, unknown>,
): Promise<void> {
	await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
}

/** A run left behind by an earlier contract revision. */
async function writeStaleRun(
	root: string,
	revision: number,
): Promise<{ runId: string; attemptId: string }> {
	const suffix = randomUUID().replaceAll("-", "");
	const runId = `run_${suffix}`;
	const attemptId = `attempt_${suffix}`;
	await writeJson(path.join(root, "run-records", `${runId}.json`), {
		schema: "pi-subagent-run-record",
		contractRevision: revision,
		ownerId: "owner",
		runId,
	});
	await writeJson(path.join(root, "leases", `${runId}.lease.json`), {
		schema: "pi-subagent-run-lease",
		contractRevision: revision,
		runId,
		leaseId: randomUUID(),
		generation: 1,
		pid: 1,
		processStartedAt: 0,
		port: 20_000,
		acquiredAt: new Date().toISOString(),
	});
	await writeJson(
		path.join(root, "attempt-records", runId, `${attemptId}.json`),
		{
			schema: "pi-subagent-attempt-record",
			contractRevision: revision,
			ownerId: "owner",
			runId,
			attemptId,
		},
	);
	await mkdir(path.join(root, "runs", runId), { recursive: true, mode: 0o700 });
	await writeFile(
		path.join(root, "runs", runId, "events.jsonl"),
		`${JSON.stringify({
			schema: "pi-subagent-event",
			contractRevision: revision,
			sequence: 1,
			runId,
			type: "attempt-starting",
		})}\n`,
		{ encoding: "utf8", mode: 0o600 },
	);
	await mkdir(path.join(root, "sessions", attemptId), {
		recursive: true,
		mode: 0o700,
	});
	await writeFile(
		path.join(root, "sessions", attemptId, "session.jsonl"),
		"{}\n",
		{ encoding: "utf8", mode: 0o600 },
	);
	await writeJson(
		path.join(root, "workspace", "records", `${attemptId}.json`),
		{
			schema: "pi-subagent-worktree-record",
			contractRevision: revision,
			attemptId,
		},
	);
	return { runId, attemptId };
}

async function missing(target: string): Promise<boolean> {
	try {
		await stat(target);
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT";
	}
}

async function startService(
	root: string,
	onNotice?: (message: string) => void,
) {
	return createSubagentService({
		root,
		agentDir: path.join(path.dirname(root), "agent"),
		agents: new Map(),
		modelRuntime: {} as ModelRuntime,
		capacity: await createVmCapacityManager({
			root: path.join(path.dirname(root), "capacity"),
			maxSlots: 1,
		}),
		sandbox: {
			packageVersion: "0.12.0",
			imageSha256: hash,
			mountPolicySha256: hash,
			networkPolicySha256: hash,
			capacityPolicySha256: hash,
			guestDiskBytes: 1024,
		},
		resolveModel: async (model) => model,
		...(onNotice ? { onNotice } : {}),
	});
}

describe("store contract revision gate", () => {
	it("starts on a store holding an older revision and quarantines it", async () => {
		const root = await store("older");
		const { runId, attemptId } = await writeStaleRun(root, STALE);
		const notices: string[] = [];

		const service = await startService(root, (message) =>
			notices.push(message),
		);
		try {
			expect((await service.listRuns({ limit: 10 })).runs).toEqual([]);
		} finally {
			await service.shutdown();
		}

		const quarantine = path.join(root, "quarantine", String(STALE));
		expect(
			JSON.parse(
				await readFile(
					path.join(quarantine, "run-records", `${runId}.json`),
					"utf8",
				),
			).contractRevision,
		).toBe(STALE);
		await expect(
			stat(path.join(quarantine, "leases", `${runId}.lease.json`)),
		).resolves.toBeDefined();
		await expect(
			stat(
				path.join(quarantine, "attempt-records", runId, `${attemptId}.json`),
			),
		).resolves.toBeDefined();
		await expect(
			stat(path.join(quarantine, "runs", runId, "events.jsonl")),
		).resolves.toBeDefined();
		await expect(
			stat(path.join(quarantine, "sessions", attemptId, "session.jsonl")),
		).resolves.toBeDefined();
		await expect(
			stat(path.join(quarantine, "workspace", "records", `${attemptId}.json`)),
		).resolves.toBeDefined();

		expect(await missing(path.join(root, "run-records", `${runId}.json`))).toBe(
			true,
		);
		expect(
			await missing(path.join(root, "leases", `${runId}.lease.json`)),
		).toBe(true);
		expect(await missing(path.join(root, "runs", runId))).toBe(true);
		expect(await missing(path.join(root, "sessions", attemptId))).toBe(true);

		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain(`revision ${STALE}`);
		expect(notices[0]).toContain(`quarantine/${STALE}`);
	});

	it("refuses a store holding a newer revision", async () => {
		const root = await store("newer");
		await writeStaleRun(root, FUTURE);

		await expect(startService(root)).rejects.toThrow(
			`persisted state uses contract revision ${FUTURE}; expected ${CONTRACT_REVISION}. Discard incompatible persisted state before continuing.`,
		);
		expect(await missing(path.join(root, "quarantine"))).toBe(true);
	});

	it("leaves a store at the current revision untouched", async () => {
		const root = await store("current");
		const { runId } = await writeStaleRun(root, CONTRACT_REVISION);

		expect(await quarantineStaleState(root)).toBeUndefined();
		await expect(
			stat(path.join(root, "run-records", `${runId}.json`)),
		).resolves.toBeDefined();
		expect(await missing(path.join(root, "quarantine"))).toBe(true);
	});

	it("quarantines owner operation records from an older revision", async () => {
		const root = await store("operations");
		await writeJson(path.join(root, "operations", `${hash}.json`), {
			schema: "pi-subagent-operation",
			contractRevision: STALE,
			ownerId: "owner",
			operationId: "operation",
		});

		const quarantine = await quarantineStaleState(root);
		expect(quarantine?.revisions).toEqual([STALE]);
		expect(quarantine?.entries).toEqual([
			path.join("operations", `${hash}.json`),
		]);
		await expect(
			stat(
				path.join(
					root,
					"quarantine",
					String(STALE),
					"operations",
					`${hash}.json`,
				),
			),
		).resolves.toBeDefined();
	});
});
