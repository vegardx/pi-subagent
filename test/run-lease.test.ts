import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunJournal } from "../src/persistence/journal.js";
import {
	acquireRunLease,
	RunLeaseFencedError,
	type RunLeaseRecord,
	RunLeaseUnavailableError,
} from "../src/persistence/run-lease.js";

const children = new Set<ChildProcess>();

function root(name: string): string {
	return path.resolve(".pi", "test-run-leases", `${name}-${randomUUID()}`);
}

function worker(leaseRoot: string, runId: string): ChildProcess {
	const child = spawn(
		process.execPath,
		["--import", "tsx", "test/fixtures/run-lease-worker.ts", leaseRoot, runId],
		{ cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
	);
	children.add(child);
	child.once("exit", () => children.delete(child));
	return child;
}

function record(child: ChildProcess): Promise<RunLeaseRecord> {
	return new Promise((resolve, reject) => {
		let output = "";
		const timeout = setTimeout(() => reject(new Error(output)), 10_000);
		child.once("error", reject);
		child.once("exit", (code) => {
			if (code) reject(new Error(`worker exited ${code}: ${output}`));
		});
		child.stdout?.on("data", (chunk) => {
			output += chunk.toString();
			const newline = output.indexOf("\n");
			if (newline < 0) return;
			clearTimeout(timeout);
			resolve(JSON.parse(output.slice(0, newline)) as RunLeaseRecord);
		});
		child.stderr?.on("data", (chunk) => {
			output += chunk.toString();
		});
	});
}

function exited(child: ChildProcess): Promise<void> {
	return new Promise((resolve) => child.once("exit", () => resolve()));
}

afterEach(async () => {
	const exits = [...children].map(exited);
	for (const child of children) child.kill("SIGKILL");
	await Promise.all(exits);
});

describe("run leases", () => {
	it("excludes another process and increments after owner death", async () => {
		const leaseRoot = root("crash");
		const child = worker(leaseRoot, "run_crash");
		const first = await record(child);
		await expect(
			acquireRunLease({ root: leaseRoot, runId: "run_crash" }),
		).rejects.toBeInstanceOf(RunLeaseUnavailableError);
		const exit = exited(child);
		child.kill("SIGKILL");
		await exit;
		const replacement = await acquireRunLease({
			root: leaseRoot,
			runId: "run_crash",
		});
		expect(replacement.record.generation).toBe(first.generation + 1);
		await replacement.release();
	});

	it("fences a released writer after replacement", async () => {
		const leaseRoot = root("fence");
		const first = await acquireRunLease({
			root: leaseRoot,
			runId: "run_fence",
		});
		await first.release();
		const second = await acquireRunLease({
			root: leaseRoot,
			runId: "run_fence",
		});
		await expect(first.assertCurrent()).rejects.toBeInstanceOf(
			RunLeaseFencedError,
		);
		await second.assertCurrent();
		await second.release();
	});

	it("prevents a fenced journal from appending", async () => {
		const base = root("journal");
		const first = await acquireRunLease({
			root: path.join(base, "leases"),
			runId: "run_journal",
		});
		const journal = await RunJournal.open(
			path.join(base, "runs"),
			"run_journal",
			first,
		);
		await journal.append("created", {});
		await first.release();
		const second = await acquireRunLease({
			root: path.join(base, "leases"),
			runId: "run_journal",
		});
		await expect(journal.append("stale", {})).rejects.toBeInstanceOf(
			RunLeaseFencedError,
		);
		const adopted = await RunJournal.open(
			path.join(base, "runs"),
			"run_journal",
			second,
		);
		expect((await adopted.append("adopted", {})).sequence).toBe(2);
		await second.release();
	});
});
