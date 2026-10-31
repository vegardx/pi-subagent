import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createVmCapacityManager,
	VmCapacityExhaustedError,
	type VmCapacityLeaseRecord,
} from "../src/sandbox/capacity.js";

const children = new Set<ChildProcess>();

function waitForRecord(child: ChildProcess): Promise<VmCapacityLeaseRecord> {
	return new Promise((resolve, reject) => {
		let output = "";
		const timeout = setTimeout(
			() => reject(new Error(`worker readiness timeout: ${output}`)),
			10_000,
		);
		child.once("error", reject);
		child.stderr?.on("data", (chunk) => {
			output += chunk.toString();
		});
		child.stdout?.on("data", (chunk) => {
			output += chunk.toString();
			const newline = output.indexOf("\n");
			if (newline < 0) return;
			clearTimeout(timeout);
			resolve(JSON.parse(output.slice(0, newline)) as VmCapacityLeaseRecord);
		});
	});
}

function waitForExit(child: ChildProcess): Promise<void> {
	return new Promise((resolve) => child.once("exit", () => resolve()));
}

function startWorker(root: string, owner: string, maxSlots: number) {
	const child = spawn(
		process.execPath,
		[
			"--import",
			"tsx",
			"test/fixtures/capacity-worker.ts",
			root,
			owner,
			String(maxSlots),
		],
		{ cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
	);
	children.add(child);
	child.once("exit", () => children.delete(child));
	return child;
}

afterEach(async () => {
	const exiting: Promise<void>[] = [];
	for (const child of children) {
		exiting.push(waitForExit(child));
		child.kill("SIGKILL");
	}
	await Promise.all(exiting);
});

describe("VM capacity manager", () => {
	it("enforces capacity across processes and recovers after a crash", async () => {
		const root = path.resolve(
			".pi",
			"test-capacity",
			`cross-process-${randomUUID()}`,
		);
		await mkdir(root, { recursive: true });
		const manager = await createVmCapacityManager({ root, maxSlots: 2 });
		const first = startWorker(root, "first", 2);
		const second = startWorker(root, "second", 2);
		const [firstRecord, secondRecord] = await Promise.all([
			waitForRecord(first),
			waitForRecord(second),
		]);
		expect(new Set([firstRecord.slot, secondRecord.slot]).size).toBe(2);
		await expect(
			manager.acquire("third", { waitMs: 0 }),
		).rejects.toBeInstanceOf(VmCapacityExhaustedError);

		const firstExit = waitForExit(first);
		first.kill("SIGKILL");
		await firstExit;
		const replacement = await manager.acquire("replacement");
		expect(replacement.record.slot).toBe(firstRecord.slot);
		await replacement.release();

		const secondExit = waitForExit(second);
		second.kill("SIGTERM");
		await secondExit;
	});

	it("rejects conflicting cross-process policies", async () => {
		const root = path.resolve(
			".pi",
			"test-capacity",
			`stable-range-${randomUUID()}`,
		);
		const first = await createVmCapacityManager({ root, maxSlots: 1 });
		const refusal = createVmCapacityManager({ root, maxSlots: 4 });
		await expect(refusal).rejects.toThrow("VM capacity policy mismatch");
		// The refusal names both slot counts and the recorded policy file.
		await expect(refusal).rejects.toThrow(
			`this seat uses maxSlots=4 basePort=${first.basePort}, but ${path.join(
				first.root,
				"policy.json",
			)} records maxSlots=1 basePort=${first.basePort}`,
		);
	});

	it("waits for a busy slot and takes it once it frees", async () => {
		const root = path.resolve(".pi", "test-capacity", `wait-${randomUUID()}`);
		const manager = await createVmCapacityManager({ root, maxSlots: 1 });
		const held = await manager.acquire("held");
		const startedAt = performance.now();
		const waiting = manager.acquire("waiting", { waitMs: 10_000 });
		setTimeout(() => void held.release(), 400);
		const lease = await waiting;
		expect(performance.now() - startedAt).toBeGreaterThanOrEqual(400);
		expect(lease.record.slot).toBe(0);
		await lease.release();
	});

	it("refuses with the slot count and the time waited once the bound passes", async () => {
		const root = path.resolve(".pi", "test-capacity", `bound-${randomUUID()}`);
		const manager = await createVmCapacityManager({
			root,
			maxSlots: 1,
			capacityWaitMs: 1_200,
		});
		const held = await manager.acquire("held");
		const startedAt = performance.now();
		const error = await manager.acquire("waiting").then(
			() => undefined,
			(caught: unknown) => caught,
		);
		expect(error).toBeInstanceOf(VmCapacityExhaustedError);
		const exhausted = error as VmCapacityExhaustedError;
		expect(performance.now() - startedAt).toBeGreaterThanOrEqual(1_200);
		expect(exhausted.maxSlots).toBe(1);
		expect(exhausted.waitedMs).toBeGreaterThanOrEqual(1_200);
		expect(exhausted.message).toBe(
			"VM capacity exhausted: 1 slots busy for 1 s",
		);
		await held.release();
	});

	it("stops waiting when the caller aborts", async () => {
		const root = path.resolve(".pi", "test-capacity", `abort-${randomUUID()}`);
		const manager = await createVmCapacityManager({ root, maxSlots: 1 });
		const held = await manager.acquire("held");
		const controller = new AbortController();
		const waiting = manager.acquire("waiting", {
			signal: controller.signal,
			waitMs: 60_000,
		});
		setTimeout(() => controller.abort("caller-interrupt"), 300);
		await expect(waiting).rejects.toBe("caller-interrupt");
		await held.release();
		// The aborted wait left no lease behind.
		const next = await manager.acquire("next", { waitMs: 0 });
		await next.release();
	});

	it("validates slot and port ranges", async () => {
		const root = path.resolve(
			".pi",
			"test-capacity",
			`validation-${randomUUID()}`,
		);
		await expect(
			createVmCapacityManager({ root, maxSlots: 0 }),
		).rejects.toThrow("maxSlots must be an integer");
		await expect(
			createVmCapacityManager({ root, maxSlots: 2, basePort: 65_535 }),
		).rejects.toThrow("basePort does not provide");
		await expect(
			createVmCapacityManager({ root, maxSlots: 1, capacityWaitMs: -1 }),
		).rejects.toThrow("capacity wait must be");
	});

	it("releases a lease idempotently", async () => {
		const root = path.resolve(
			".pi",
			"test-capacity",
			`release-${randomUUID()}`,
		);
		const manager = await createVmCapacityManager({ root, maxSlots: 1 });
		const lease = await manager.acquire("owner");
		await lease.release();
		await lease.release();
		const next = await manager.acquire("next");
		await next.release();
	});
});
