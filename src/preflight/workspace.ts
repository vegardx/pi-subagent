import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { WorkspaceRequest } from "../launch-contracts.js";
import { canonicalSha256 } from "./canonical.js";
import type { ResolvedWorkspace } from "./compile.js";

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT = 64 * 1024 * 1024;
const MAX_UNTRACKED_FILES = 10_000;
const MAX_UNTRACKED_BYTES = 256 * 1024 * 1024;

export type WorkspacePreflight = ResolvedWorkspace & {
	repositoryRoot: string;
	cwd: string;
	relativeCwd: string;
	head: string;
	dirty: boolean;
};

export class WorkspacePreflightError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "WorkspacePreflightError";
	}
}

async function git(
	cwd: string,
	args: string[],
	signal?: AbortSignal,
): Promise<Buffer> {
	try {
		const result = await execFileAsync("git", args, {
			cwd,
			encoding: "buffer",
			maxBuffer: MAX_GIT_OUTPUT,
			env: {
				...process.env,
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_TERMINAL_PROMPT: "0",
			},
			...(signal ? { signal } : {}),
		});
		return result.stdout;
	} catch (error) {
		signal?.throwIfAborted();
		throw new WorkspacePreflightError(
			`git preflight failed: git ${args.join(" ")}`,
			{ cause: error },
		);
	}
}

function isInside(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return (
		relative === "" ||
		(relative !== ".." &&
			!relative.startsWith(`..${path.sep}`) &&
			!path.isAbsolute(relative))
	);
}

async function digestUntracked(
	repositoryRoot: string,
	paths: string[],
): Promise<Array<{ path: string; type: "file" | "symlink"; sha256: string }>> {
	if (paths.length > MAX_UNTRACKED_FILES) {
		throw new WorkspacePreflightError("untracked files exceed count limit");
	}
	let bytes = 0;
	const entries: Array<{
		path: string;
		type: "file" | "symlink";
		sha256: string;
	}> = [];
	for (const relativePath of paths.sort()) {
		const absolutePath = path.resolve(repositoryRoot, relativePath);
		if (!isInside(repositoryRoot, absolutePath)) {
			throw new WorkspacePreflightError("untracked path escapes repository");
		}
		const metadata = await lstat(absolutePath);
		let content: Buffer;
		let type: "file" | "symlink";
		if (metadata.isSymbolicLink()) {
			content = Buffer.from(await readlink(absolutePath));
			type = "symlink";
		} else if (metadata.isFile()) {
			content = await readFile(absolutePath);
			type = "file";
		} else {
			throw new WorkspacePreflightError(
				`unsupported untracked entry: ${relativePath}`,
			);
		}
		bytes += content.byteLength;
		if (bytes > MAX_UNTRACKED_BYTES) {
			throw new WorkspacePreflightError("untracked files exceed byte limit");
		}
		entries.push({
			path: relativePath.split(path.sep).join(path.posix.sep),
			type,
			sha256: createHash("sha256").update(content).digest("hex"),
		});
	}
	return entries;
}

export async function preflightWorkspace(
	request: WorkspaceRequest,
	signal?: AbortSignal,
): Promise<WorkspacePreflight> {
	signal?.throwIfAborted();
	const cwd = await realpath(request.cwd);
	const repositoryRoot = (
		await git(cwd, ["rev-parse", "--show-toplevel"], signal)
	)
		.toString("utf8")
		.trim();
	const canonicalRoot = await realpath(repositoryRoot);
	if (!isInside(canonicalRoot, cwd)) {
		throw new WorkspacePreflightError("cwd is outside repository root");
	}
	const relativeCwd = path.relative(canonicalRoot, cwd) || ".";
	const head = (
		await git(canonicalRoot, ["rev-parse", "--verify", "HEAD"], signal)
	)
		.toString("utf8")
		.trim();
	const status = await git(
		canonicalRoot,
		["status", "--porcelain=v1", "-z", "--untracked-files=all"],
		signal,
	);
	const dirty = status.byteLength > 0;
	if (request.mode === "worktree" && dirty) {
		throw new WorkspacePreflightError(
			"worktree workspace requires a clean repository",
		);
	}

	let baselineSha256: string;
	if (!dirty) {
		baselineSha256 = canonicalSha256({ head });
	} else {
		const diff = await git(
			canonicalRoot,
			["diff", "--binary", "--no-ext-diff", "HEAD"],
			signal,
		);
		const untrackedOutput = await git(
			canonicalRoot,
			["ls-files", "--others", "--exclude-standard", "-z"],
			signal,
		);
		const untrackedPaths = untrackedOutput
			.toString("utf8")
			.split("\0")
			.filter(Boolean);
		baselineSha256 = canonicalSha256({
			head,
			status: status.toString("base64"),
			diff: diff.toString("base64"),
			untracked: await digestUntracked(canonicalRoot, untrackedPaths),
		});
	}

	return {
		mode: request.mode,
		repositoryRoot: canonicalRoot,
		cwd,
		relativeCwd: relativeCwd.split(path.sep).join(path.posix.sep),
		head,
		dirty,
		hostPathSha256: canonicalSha256({
			repositoryRoot: canonicalRoot,
			relativeCwd: relativeCwd.split(path.sep).join(path.posix.sep),
		}),
		baselineSha256,
	};
}
