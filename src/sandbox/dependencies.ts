import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gitEnvironment } from "../workspace/worktree.js";

const execFileAsync = promisify(execFile);

/** Guest root-disk directory that holds every bound dependency directory. */
export const GUEST_DEPENDENCY_ROOT = "/var/lib/pi-subagent/deps";
/** Bound on dependency directories one attempt binds. */
export const MAX_DEPENDENCY_DIRECTORIES = 64;
const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;

export type DependencySkipReason =
	| "not-ignored"
	| "ignore-check-failed"
	| "symlink"
	| "not-a-directory"
	| "absent-in-read-only-workspace"
	| "unsupported-pattern"
	| "limit";

export type DependencyDirectoryPlan = {
	/** Workspace-relative POSIX paths bound onto the root disk, sorted. */
	bound: string[];
	skipped: Array<{ path: string; reason: DependencySkipReason }>;
};

/**
 * Where a bound directory lives on the guest root disk. Named by a digest of
 * its workspace path, so a warm checkpoint and a later attempt agree on the
 * location without agreeing on an order.
 */
export function guestDependencyPath(relativePath: string): string {
	const digest = createHash("sha256")
		.update(relativePath)
		.digest("hex")
		.slice(0, 32);
	return `${GUEST_DEPENDENCY_ROOT}/${digest}`;
}

async function readRootManifest(
	workspace: string,
): Promise<Record<string, unknown> | undefined> {
	try {
		const file = path.join(workspace, "package.json");
		const info = await lstat(file);
		if (!info.isFile() || info.size > MAX_PACKAGE_JSON_BYTES) return undefined;
		const value: unknown = JSON.parse(await readFile(file, "utf8"));
		return typeof value === "object" && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

/** The root `package.json` `workspaces` patterns, in either npm form. */
export function workspacePatterns(manifest: unknown): string[] {
	if (typeof manifest !== "object" || manifest === null) return [];
	const field = (manifest as { workspaces?: unknown }).workspaces;
	const list = Array.isArray(field)
		? field
		: typeof field === "object" && field !== null
			? (field as { packages?: unknown }).packages
			: undefined;
	return Array.isArray(list)
		? list.filter((item): item is string => typeof item === "string")
		: [];
}

function segmentPattern(segment: string): RegExp {
	const escaped = segment.replace(/[.+?^${}()|[\]\\]/gu, "\\$&");
	return new RegExp(`^${escaped.replaceAll("*", "[^/]*")}$`, "u");
}

async function realDirectory(target: string): Promise<boolean> {
	try {
		return (await lstat(target)).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Expand one workspace pattern to member directories. Only relative patterns
 * of literal or single-segment `*` parts are supported; `**`, negation, and
 * anything that leaves the workspace are refused. Symlinked members are never
 * followed.
 */
async function expandPattern(
	workspace: string,
	pattern: string,
): Promise<string[] | undefined> {
	const normalized = path.posix.normalize(pattern.replace(/\/+$/u, ""));
	if (
		!normalized ||
		normalized === "." ||
		normalized.startsWith("/") ||
		normalized.startsWith("!") ||
		normalized.split("/").some((part) => part === ".." || part === "**")
	) {
		return undefined;
	}
	let current = [""];
	for (const segment of normalized.split("/")) {
		const next: string[] = [];
		for (const base of current) {
			if (!segment.includes("*")) {
				const candidate = path.posix.join(base, segment);
				if (await realDirectory(path.join(workspace, candidate))) {
					next.push(candidate);
				}
				continue;
			}
			let entries: string[];
			try {
				entries = await readdir(path.join(workspace, base));
			} catch {
				continue;
			}
			const matcher = segmentPattern(segment);
			for (const entry of entries.sort()) {
				if (!matcher.test(entry) || entry.startsWith(".")) continue;
				const candidate = path.posix.join(base, entry);
				if (await realDirectory(path.join(workspace, candidate))) {
					next.push(candidate);
				}
			}
		}
		current = next;
	}
	return current;
}

async function isIgnored(
	workspace: string,
	relativePath: string,
): Promise<boolean | undefined> {
	try {
		await execFileAsync(
			"git",
			[
				"-c",
				"core.fsmonitor=false",
				"check-ignore",
				"-q",
				"--",
				// The trailing slash asks about a directory, so a directory-only
				// rule such as `node_modules/` matches one that does not exist yet.
				`${relativePath}/`,
			],
			{ cwd: workspace, env: gitEnvironment(), timeout: 10_000 },
		);
		return true;
	} catch (error) {
		return (error as { code?: unknown }).code === 1 ? false : undefined;
	}
}

/**
 * Which dependency directories of the workspace an attempt binds onto the
 * guest root disk: the root `node_modules` and each `workspaces` member's
 * `node_modules`, when the package exists. A directory is bound only when the
 * workspace's own Git says it is ignored, so nothing bound could have reached
 * a handoff. With `createMountpoints` an absent directory is created empty on
 * the host side of the mount (the host owns that checkout); otherwise an
 * absent one is skipped, because the host checkout is not ours to change.
 */
export async function planDependencyDirectories(options: {
	workspace: string;
	createMountpoints: boolean;
}): Promise<DependencyDirectoryPlan> {
	const plan: DependencyDirectoryPlan = { bound: [], skipped: [] };
	const manifest = await readRootManifest(options.workspace);
	if (!manifest) return plan;
	const members = new Set<string>([""]);
	for (const pattern of workspacePatterns(manifest)) {
		const expanded = await expandPattern(options.workspace, pattern);
		if (!expanded) {
			plan.skipped.push({ path: pattern, reason: "unsupported-pattern" });
			continue;
		}
		for (const member of expanded) {
			try {
				if (
					(
						await lstat(path.join(options.workspace, member, "package.json"))
					).isFile()
				) {
					members.add(member);
				}
			} catch {}
		}
	}
	for (const member of [...members].sort()) {
		const relativePath = path.posix.join(member, "node_modules");
		if (plan.bound.length >= MAX_DEPENDENCY_DIRECTORIES) {
			plan.skipped.push({ path: relativePath, reason: "limit" });
			continue;
		}
		const hostPath = path.join(options.workspace, relativePath);
		let exists = false;
		try {
			const info = await lstat(hostPath);
			if (info.isSymbolicLink()) {
				plan.skipped.push({ path: relativePath, reason: "symlink" });
				continue;
			}
			if (!info.isDirectory()) {
				plan.skipped.push({ path: relativePath, reason: "not-a-directory" });
				continue;
			}
			exists = true;
		} catch {}
		const ignored = await isIgnored(options.workspace, relativePath);
		if (ignored === undefined) {
			plan.skipped.push({ path: relativePath, reason: "ignore-check-failed" });
			continue;
		}
		if (!ignored) {
			plan.skipped.push({ path: relativePath, reason: "not-ignored" });
			continue;
		}
		if (!exists) {
			if (!options.createMountpoints) {
				plan.skipped.push({
					path: relativePath,
					reason: "absent-in-read-only-workspace",
				});
				continue;
			}
			await mkdir(hostPath, { mode: 0o755 });
		}
		plan.bound.push(relativePath);
	}
	return plan;
}

/** Shell-free guest commands that bind each planned directory. */
export function dependencyBindCommands(
	plan: DependencyDirectoryPlan,
	guestWorkspace: string,
): string[][] {
	return plan.bound.flatMap((relativePath) => {
		const source = guestDependencyPath(relativePath);
		return [
			["/bin/mkdir", "-p", source],
			[
				"/bin/mount",
				"--bind",
				source,
				path.posix.join(guestWorkspace, relativePath),
			],
		];
	});
}
