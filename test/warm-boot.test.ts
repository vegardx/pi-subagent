import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createVmCapacityManager } from "../src/sandbox/capacity.js";
import { WarmCheckpointStore } from "../src/sandbox/checkpoints.js";
import { createGondolinAttemptSandbox } from "../src/sandbox/gondolin.js";

const execFileAsync = promisify(execFile);
const BUILD_ID = "9ec8f6c5-bd1f-5ac8-9bc2-2efd531c2359";

const fake = vi.hoisted(() => ({
	created: 0,
	resumed: 0,
	installExit: 0,
	checkpointBuildId: "9ec8f6c5-bd1f-5ac8-9bc2-2efd531c2359",
	commands: [] as string[][],
}));

vi.mock("@earendil-works/gondolin", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("@earendil-works/gondolin")>();
	const { writeFile: write } = await import("node:fs/promises");
	function vm() {
		let closed = false;
		return {
			id: `vm-${Math.random()}`,
			start: async () => {},
			close: async () => {
				closed = true;
			},
			getHostPid: () => (closed ? null : process.pid),
			exec: async (command: string[] | string) => {
				const argv = Array.isArray(command) ? command : [command];
				fake.commands.push(argv);
				const install = argv.join(" ").includes("npm ci");
				return {
					exitCode: install ? fake.installExit : 0,
					ok: true,
					stdout: "",
					stderr: "",
				};
			},
			checkpoint: async (target: string) => {
				await write(target, "qcow2");
				closed = true;
			},
		};
	}
	return {
		...original,
		VM: {
			create: async () => {
				fake.created += 1;
				return vm();
			},
		},
		VmCheckpoint: {
			load: () => ({
				guestAssetBuildId: fake.checkpointBuildId,
				resume: async () => {
					fake.resumed += 1;
					return vm();
				},
			}),
		},
	};
});

vi.mock("../src/reconciliation/process.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../src/reconciliation/process.js")
	>()),
	captureQemuProcessIdentity: async () => ({}),
}));

async function project(): Promise<string> {
	const root = path.resolve(".pi", "test-warm-boot", randomUUID());
	await mkdir(root, { recursive: true });
	await execFileAsync("git", ["init", "-q"], { cwd: root });
	await writeFile(path.join(root, ".gitignore"), "node_modules/\n");
	await writeFile(
		path.join(root, "package.json"),
		JSON.stringify({ name: "fixture", version: "1.0.0" }),
	);
	await writeFile(path.join(root, "package-lock.json"), "{}\n");
	return root;
}

async function attempt(workspace: string, store: WarmCheckpointStore) {
	const capacity = await createVmCapacityManager({
		root: path.join(store.root, "..", `capacity-${randomUUID()}`),
		maxSlots: 1,
	});
	const sandbox = await createGondolinAttemptSandbox({
		owner: "warm-boot",
		workspace,
		readOnly: false,
		workspaceWriteBytes: 1024,
		capacity,
		memoryBytes: 1024 * 1024 * 1024,
		createDependencyMountpoints: true,
		warmCheckpoints: { store, guestAssetBuildId: BUILD_ID },
	});
	await sandbox.close();
	return sandbox.record;
}

function newStore(): WarmCheckpointStore {
	return new WarmCheckpointStore({
		root: path.resolve(".pi", "test-warm-boot", randomUUID(), "checkpoints"),
	});
}

describe("warm checkpoint boot", () => {
	beforeEach(() => {
		fake.created = 0;
		fake.resumed = 0;
		fake.installExit = 0;
		fake.checkpointBuildId = BUILD_ID;
		fake.commands = [];
	});

	it("warms a project once, then resumes every attempt from the checkpoint", async () => {
		const workspace = await project();
		const store = newStore();
		const first = await attempt(workspace, store);
		expect(first.boot).toMatchObject({ mode: "warm", warmup: "created" });
		expect(first.boot.checkpointKey).toMatch(/^[a-f0-9]{64}$/u);
		expect(first.dependencies.bound).toEqual(["node_modules"]);
		// The warm-up VM is the only cold boot; the attempt resumed.
		expect(fake.created).toBe(1);
		expect(fake.resumed).toBe(1);
		expect(
			fake.commands.some((argv) => argv.join(" ").includes("npm ci")),
		).toBe(true);

		const second = await attempt(workspace, store);
		expect(second.boot).toEqual({
			mode: "warm",
			warmup: "reused",
			checkpointKey: first.boot.checkpointKey,
		});
		expect(fake.created).toBe(1);
		expect(fake.resumed).toBe(2);
		// Both attempts released their lease once their VM closed.
		const leases = await readdir(
			path.join(store.root, "leases", first.boot.checkpointKey as string),
		);
		expect(leases).toEqual([]);
	});

	it("boots cold and keeps the key cold after a failed warm-up", async () => {
		const workspace = await project();
		const store = newStore();
		fake.installExit = 1;
		const first = await attempt(workspace, store);
		expect(first.boot).toMatchObject({
			mode: "cold",
			warmup: "failed",
			failure: "install-failed",
		});
		expect(fake.resumed).toBe(0);
		expect(fake.created).toBe(2);
		fake.installExit = 0;
		const second = await attempt(workspace, store);
		expect(second.boot).toMatchObject({
			mode: "cold",
			warmup: "failed-recently",
		});
		expect(fake.created).toBe(3);
	});

	it("boots cold when the checkpoint was made from another guest image", async () => {
		const workspace = await project();
		const store = newStore();
		await attempt(workspace, store);
		fake.checkpointBuildId = "other-build";
		const record = await attempt(workspace, store);
		expect(record.boot).toMatchObject({
			mode: "cold",
			warmup: "build-mismatch",
		});
	});

	it("boots cold without warm-up for a project without an npm lockfile", async () => {
		const workspace = await project();
		await execFileAsync(
			"git",
			["rm", "-q", "--cached", "--ignore-unmatch", "x"],
			{
				cwd: workspace,
			},
		);
		const { unlink } = await import("node:fs/promises");
		await unlink(path.join(workspace, "package-lock.json"));
		const record = await attempt(workspace, newStore());
		expect(record.boot).toEqual({ mode: "cold", warmup: "no-lockfile" });
		expect(fake.created).toBe(1);
	});
});
