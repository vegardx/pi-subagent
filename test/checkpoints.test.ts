import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	mkdir,
	readdir,
	readFile,
	stat,
	utimes,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_CHECKPOINT_STORE_BYTES,
	detectWarmProject,
	WARM_CHECKPOINT_SCHEMA,
	type WarmCheckpointInputs,
	WarmCheckpointStore,
	warmCheckpointKey,
} from "../src/sandbox/checkpoints.js";

const baseInputs: WarmCheckpointInputs = {
	schema: WARM_CHECKPOINT_SCHEMA,
	installCommand: "npm ci",
	lockfileSha256: "a".repeat(64),
	workspaces: null,
	dependencies: ["node_modules"],
	guestAssetBuildId: "9ec8f6c5-bd1f-5ac8-9bc2-2efd531c2359",
	gondolinVersion: "0.14.0",
	rootfsPolicySha256: "b".repeat(64),
	guestCacheHome: "/var/cache/pi-subagent",
};

function storeRoot(): string {
	return path.resolve(".pi", "test-checkpoints", randomUUID());
}

async function publish(
	store: WarmCheckpointStore,
	inputs: WarmCheckpointInputs,
	bytes: number,
): Promise<string> {
	const key = warmCheckpointKey(inputs);
	const temporary = await store.temporaryPath();
	await writeFile(temporary, Buffer.alloc(bytes));
	await store.publish(key, temporary, inputs);
	return key;
}

/** A process id that is certainly gone. */
async function deadPid(): Promise<number> {
	const child = spawn(process.execPath, ["-e", ""]);
	const pid = child.pid as number;
	await new Promise((resolve) => child.once("exit", resolve));
	return pid;
}

describe("warm checkpoint keys", () => {
	it("changes with every input and only with them", () => {
		const key = warmCheckpointKey(baseInputs);
		expect(key).toMatch(/^[a-f0-9]{64}$/u);
		expect(warmCheckpointKey({ ...baseInputs })).toBe(key);
		for (const changed of [
			{ lockfileSha256: "c".repeat(64) },
			{ workspaces: ["packages/*"] },
			{ dependencies: ["node_modules", "packages/a/node_modules"] },
			{ guestAssetBuildId: "other" },
			{ gondolinVersion: "0.15.0" },
			{ rootfsPolicySha256: "d".repeat(64) },
			{ guestCacheHome: "/tmp/cache" },
		]) {
			expect(warmCheckpointKey({ ...baseInputs, ...changed })).not.toBe(key);
		}
	});

	it("detects an npm project by its lockfile and refuses other managers", async () => {
		const root = storeRoot();
		await mkdir(root, { recursive: true });
		expect(await detectWarmProject(root)).toEqual({
			kind: "skip",
			reason: "no-lockfile",
		});
		await writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
		expect(await detectWarmProject(root)).toEqual({
			kind: "skip",
			reason: "unsupported-lockfile",
		});
		await writeFile(path.join(root, "package-lock.json"), "{}\n");
		await writeFile(
			path.join(root, "package.json"),
			JSON.stringify({ workspaces: ["packages/*"] }),
		);
		expect(await detectWarmProject(root)).toEqual({
			kind: "npm",
			lockfileSha256:
				"ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356",
			workspaces: ["packages/*"],
		});
	});
});

describe("warm checkpoint store", () => {
	it("defaults to a 20 GiB bound", () => {
		expect(DEFAULT_CHECKPOINT_STORE_BYTES).toBe(20 * 1024 * 1024 * 1024);
	});

	it("leases only a published checkpoint", async () => {
		const store = new WarmCheckpointStore({ root: storeRoot() });
		const key = warmCheckpointKey(baseInputs);
		expect(await store.lease(key)).toBeUndefined();
		await publish(store, baseInputs, 16);
		const lease = await store.lease(key);
		expect(lease?.path).toBe(store.checkpointPath(key));
		const sidecar = await store.readSidecar(key);
		expect(sidecar).toMatchObject({ key, inputs: baseInputs, sizeBytes: 16 });
		await lease?.release();
	});

	it("evicts least recently used checkpoints but never a leased or locked one", async () => {
		let clock = Date.parse("2026-10-31T00:00:00Z");
		const store = new WarmCheckpointStore({
			root: storeRoot(),
			maxBytes: 250,
			now: () => clock,
		});
		const keys: string[] = [];
		for (const [index, lockfile] of ["1", "2", "3", "4"].entries()) {
			clock += 1_000;
			const key = await publish(
				store,
				{ ...baseInputs, lockfileSha256: lockfile.repeat(64) },
				100,
			);
			const usedAt = new Date(clock + index);
			await utimes(path.join(store.root, `${key}.json`), usedAt, usedAt);
			keys.push(key);
		}
		const [oldest, second, third, newest] = keys as [
			string,
			string,
			string,
			string,
		];
		const lease = await store.lease(oldest);
		const unlock = await store.tryLock(second);
		// The lease made the oldest the most recently used; 400 bytes over a
		// 250-byte bound must lose two, and only third is unprotected besides
		// the newest.
		expect(await store.evict()).toEqual({ evicted: 2, evictedBytes: 200 });
		const remaining = (await readdir(store.root)).filter((entry) =>
			entry.endsWith(".qcow2"),
		);
		expect(remaining.sort()).toEqual(
			[`${oldest}.qcow2`, `${second}.qcow2`].sort(),
		);
		expect(await store.readSidecar(third)).toBeUndefined();
		expect(await store.readSidecar(newest)).toBeUndefined();
		await lease?.release();
		await unlock?.();
	});

	it("takes one warm-up per key and reclaims a lock whose process is gone", async () => {
		const store = new WarmCheckpointStore({ root: storeRoot() });
		const key = warmCheckpointKey(baseInputs);
		const unlock = await store.tryLock(key);
		expect(unlock).toBeTypeOf("function");
		expect(await store.tryLock(key)).toBeUndefined();
		await unlock?.();
		const again = await store.tryLock(key);
		expect(again).toBeTypeOf("function");
		await again?.();

		await writeFile(
			path.join(store.root, `${key}.lock`),
			JSON.stringify({ pid: await deadPid(), createdAt: "x" }),
		);
		const reclaimed = await store.tryLock(key);
		expect(reclaimed).toBeTypeOf("function");
		await reclaimed?.();
	});

	it("tells a waiter when the warm-up publishes, fails, or is abandoned", async () => {
		const store = new WarmCheckpointStore({ root: storeRoot() });
		const key = warmCheckpointKey(baseInputs);
		const unlock = await store.tryLock(key);
		const waiting = store.waitFor(key, { timeoutMs: 10_000 });
		setTimeout(() => void publish(store, baseInputs, 8), 200);
		expect(await waiting).toBe("ready");
		await unlock?.();

		const other = { ...baseInputs, lockfileSha256: "e".repeat(64) };
		const otherKey = warmCheckpointKey(other);
		const otherUnlock = await store.tryLock(otherKey);
		expect(await store.waitFor(otherKey, { timeoutMs: 600 })).toBe("timeout");
		await store.recordFailure(otherKey, "install-failed");
		expect(await store.waitFor(otherKey, { timeoutMs: 600 })).toBe("failed");
		await otherUnlock?.();

		const third = warmCheckpointKey({
			...baseInputs,
			lockfileSha256: "f".repeat(64),
		});
		expect(await store.waitFor(third, { timeoutMs: 600 })).toBe("abandoned");
	});

	it("keeps a failed key cold for the retry window and records only a code", async () => {
		let clock = Date.parse("2026-10-31T00:00:00Z");
		const store = new WarmCheckpointStore({
			root: storeRoot(),
			failureRetryMs: 60_000,
			now: () => clock,
		});
		const key = warmCheckpointKey(baseInputs);
		expect(await store.failedRecently(key)).toBe(false);
		await store.recordFailure(key, "timeout");
		const failure = path.join(store.root, `${key}.failed.json`);
		expect(JSON.parse(await readFile(failure, "utf8"))).toEqual({
			schema: WARM_CHECKPOINT_SCHEMA,
			key,
			code: "timeout",
			failedAt: "2026-10-31T00:00:00.000Z",
		});
		const recorded = (await stat(failure)).mtimeMs;
		clock = recorded + 59_000;
		expect(await store.failedRecently(key)).toBe(true);
		clock = recorded + 61_000;
		expect(await store.failedRecently(key)).toBe(false);
		await publish(store, baseInputs, 8);
		clock = recorded;
		expect(await store.failedRecently(key)).toBe(false);
	});
});
