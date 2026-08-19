import { randomUUID } from "node:crypto";
import { stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ArtifactStore, ArtifactStoreError } from "../src/artifacts/store.js";
import { acquireRunLease } from "../src/persistence/run-lease.js";

function root(name: string): string {
	return path.resolve(".pi", "test-artifacts", `${name}-${randomUUID()}`);
}

async function openStore(
	name: string,
	maxArtifactBytes: number,
	maxTotalBytes: number,
) {
	const base = root(name);
	const lease = await acquireRunLease({
		root: path.join(base, "leases"),
		runId: "run_artifacts",
	});
	return ArtifactStore.open({
		root: path.join(base, "blobs"),
		maxArtifactBytes,
		maxTotalBytes,
		lease,
	});
}

describe("artifact store", () => {
	it("stores, deduplicates, verifies, and exports bounded content", async () => {
		const store = await openStore("basic", 1024, 2048);
		const input = Buffer.from("artifact content");
		const first = await store.put(input, "text/plain");
		input.fill(0);
		const second = await store.put("artifact content", "text/plain");
		expect(second).toEqual(first);
		const exported = await store.export(first);
		expect(exported.content.toString("utf8")).toBe("artifact content");
		expect((await stat(store.root)).mode & 0o777).toBe(0o700);
		expect(
			(await stat(path.join(store.root, `${first.sha256}.blob`))).mode & 0o777,
		).toBe(0o600);
	});

	it("enforces per-artifact, total, and export bounds", async () => {
		const store = await openStore("bounds", 4, 6);
		await expect(store.put("12345", "text/plain")).rejects.toThrow(
			"artifact exceeds byte limit",
		);
		const first = await store.put("1234", "text/plain");
		await store.put("56", "text/plain");
		await expect(store.put("7", "text/plain")).rejects.toThrow(
			"total limit exceeded",
		);
		await expect(store.export(first, 3)).rejects.toThrow(
			"export exceeds byte limit",
		);
	});

	it("rejects a fenced artifact writer", async () => {
		const base = root("fenced");
		const first = await acquireRunLease({
			root: path.join(base, "leases"),
			runId: "run_artifacts",
		});
		const store = await ArtifactStore.open({
			root: path.join(base, "blobs"),
			maxArtifactBytes: 1024,
			maxTotalBytes: 2048,
			lease: first,
		});
		await first.release();
		const second = await acquireRunLease({
			root: path.join(base, "leases"),
			runId: "run_artifacts",
		});
		await expect(store.put("stale", "text/plain")).rejects.toMatchObject({
			name: "RunLeaseFencedError",
		});
		await second.release();
	});

	it("rejects invalid media types and corrupted content", async () => {
		const store = await openStore("corrupt", 1024, 2048);
		await expect(
			store.put("content", "not-a-media-type"),
		).rejects.toBeInstanceOf(ArtifactStoreError);
		const ref = await store.put("content", "text/plain");
		await writeFile(path.join(store.root, `${ref.sha256}.blob`), "xxxxxxx");
		await expect(store.export(ref)).rejects.toThrow("artifact digest mismatch");
		await expect(store.put("content", "text/plain")).rejects.toThrow(
			"existing artifact digest mismatch",
		);
	});
});
