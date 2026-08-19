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
		await expect(manager.acquire("third")).rejects.toBeInstanceOf(
			VmCapacityExhaustedError,
		);

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
		await createVmCapacityManager({ root, maxSlots: 1 });
		await expect(
			createVmCapacityManager({ root, maxSlots: 4 }),
		).rejects.toThrow("VM capacity policy mismatch");
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
