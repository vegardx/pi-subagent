import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
	dependencyBindCommands,
	GUEST_DEPENDENCY_ROOT,
	guestDependencyPath,
	planDependencyDirectories,
	workspacePatterns,
} from "../src/sandbox/dependencies.js";

const execFileAsync = promisify(execFile);

async function repository(files: Record<string, string>): Promise<string> {
	const root = path.resolve(".pi", "test-dependencies", randomUUID());
	await mkdir(root, { recursive: true });
	await execFileAsync("git", ["init", "-q"], { cwd: root });
	for (const [name, content] of Object.entries(files)) {
		await mkdir(path.dirname(path.join(root, name)), { recursive: true });
		await writeFile(path.join(root, name), content);
	}
	return root;
}

const manifest = (workspaces?: unknown) =>
	JSON.stringify({ name: "fixture", version: "1.0.0", workspaces });

describe("dependency directory planning", () => {
	it("binds an ignored root node_modules and creates the mountpoint it owns", async () => {
		const root = await repository({
			"package.json": manifest(),
			".gitignore": "node_modules/\n",
		});
		const plan = await planDependencyDirectories({
			workspace: root,
			createMountpoints: true,
		});
		expect(plan).toEqual({ bound: ["node_modules"], skipped: [] });
		expect(await readdir(path.join(root, "node_modules"))).toEqual([]);
	});

	it("never binds a directory Git would not ignore", async () => {
		const root = await repository({ "package.json": manifest() });
		const plan = await planDependencyDirectories({
			workspace: root,
			createMountpoints: true,
		});
		expect(plan).toEqual({
			bound: [],
			skipped: [{ path: "node_modules", reason: "not-ignored" }],
		});
		await expect(readdir(path.join(root, "node_modules"))).rejects.toThrow();
	});

	it("does not create a mountpoint in a checkout the host does not own", async () => {
		const root = await repository({
			"package.json": manifest(),
			".gitignore": "node_modules\n",
		});
		const absent = await planDependencyDirectories({
			workspace: root,
			createMountpoints: false,
		});
		expect(absent).toEqual({
			bound: [],
			skipped: [
				{ path: "node_modules", reason: "absent-in-read-only-workspace" },
			],
		});
		await mkdir(path.join(root, "node_modules"));
		expect(
			await planDependencyDirectories({
				workspace: root,
				createMountpoints: false,
			}),
		).toEqual({ bound: ["node_modules"], skipped: [] });
	});

	it("binds nested workspace members and records what it skips", async () => {
		const root = await repository({
			"package.json": manifest(["packages/*", "tools/cli", "**/deep", "!x"]),
			".gitignore": "/node_modules/\npackages/*/node_modules/\n",
			"packages/a/package.json": manifest(),
			"packages/b/package.json": manifest(),
			"packages/no-manifest/README.md": "",
			"tools/cli/package.json": manifest(),
		});
		await mkdir(path.join(root, "packages", "linked"), { recursive: true });
		await writeFile(
			path.join(root, "packages", "linked", "package.json"),
			"{}",
		);
		await symlink(
			path.join(root, "packages", "a"),
			path.join(root, "packages", "alias"),
		);
		const plan = await planDependencyDirectories({
			workspace: root,
			createMountpoints: true,
		});
		expect(plan.bound).toEqual([
			"node_modules",
			"packages/a/node_modules",
			"packages/b/node_modules",
			"packages/linked/node_modules",
		]);
		expect(plan.skipped).toEqual([
			{ path: "**/deep", reason: "unsupported-pattern" },
			{ path: "!x", reason: "unsupported-pattern" },
			{ path: "tools/cli/node_modules", reason: "not-ignored" },
		]);
	});

	it("skips a symlinked dependency directory", async () => {
		const root = await repository({
			"package.json": manifest(),
			".gitignore": "node_modules\n",
		});
		await mkdir(path.join(root, "elsewhere"));
		await symlink(
			path.join(root, "elsewhere"),
			path.join(root, "node_modules"),
		);
		expect(
			await planDependencyDirectories({
				workspace: root,
				createMountpoints: true,
			}),
		).toEqual({
			bound: [],
			skipped: [{ path: "node_modules", reason: "symlink" }],
		});
	});

	it("plans nothing without a root package.json", async () => {
		const root = await repository({ ".gitignore": "node_modules/\n" });
		expect(
			await planDependencyDirectories({
				workspace: root,
				createMountpoints: true,
			}),
		).toEqual({ bound: [], skipped: [] });
	});

	it("reads both npm workspaces forms", () => {
		expect(workspacePatterns({ workspaces: ["a/*"] })).toEqual(["a/*"]);
		expect(workspacePatterns({ workspaces: { packages: ["b"] } })).toEqual([
			"b",
		]);
		expect(workspacePatterns({ workspaces: "a" })).toEqual([]);
	});

	it("binds each directory to a stable root-disk path without a shell", () => {
		const commands = dependencyBindCommands(
			{ bound: ["node_modules", "packages/a/node_modules"], skipped: [] },
			"/workspace",
		);
		const source = guestDependencyPath("node_modules");
		expect(source.startsWith(`${GUEST_DEPENDENCY_ROOT}/`)).toBe(true);
		expect(guestDependencyPath("node_modules")).toBe(source);
		expect(commands[0]).toEqual(["/bin/mkdir", "-p", source]);
		expect(commands[1]).toEqual([
			"/bin/mount",
			"--bind",
			source,
			"/workspace/node_modules",
		]);
		expect(commands[3]?.[3]).toBe("/workspace/packages/a/node_modules");
	});
});
