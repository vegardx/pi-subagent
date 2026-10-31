import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { WorkspaceRequest } from "../launch-contracts.js";
import {
	HANDOFF_REF_PATTERN,
	HANDOFF_REF_PREFIX,
} from "../workspace/worktree.js";
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

/** The request that re-resolves an already-preflighted workspace. */
export function repeatWorkspaceRequest(workspace: {
	mode: WorkspaceRequest["mode"];
	cwd: string;
	startAt?: string;
}): WorkspaceRequest {
	return {
		mode: workspace.mode,
		cwd: workspace.cwd,
		...(workspace.startAt ? { startAt: workspace.startAt } : {}),
	};
}

async function revParseCommit(
	cwd: string,
	commit: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	try {
		return (
			await execFileAsync(
				"git",
				[
					"--no-replace-objects",
					"rev-parse",
					"--verify",
					"--quiet",
					"--end-of-options",
					`${commit}^{commit}`,
				],
				{
					cwd,
					encoding: "utf8",
					maxBuffer: 4096,
					env: {
						...process.env,
						GIT_CONFIG_NOSYSTEM: "1",
						GIT_TERMINAL_PROMPT: "0",
					},
					...(signal ? { signal } : {}),
				},
			)
		).stdout.trim();
	} catch (error) {
		signal?.throwIfAborted();
		// `rev-parse --verify --quiet` exits 1 only for an unknown object; any
		// other failure is not evidence that the commit is absent.
		if ((error as { code?: unknown }).code === 1) return undefined;
		throw new WorkspacePreflightError("git preflight failed: rev-parse", {
			cause: error,
		});
	}
}

/**
 * A workspace may start only at a hand-off this repository already holds, and
 * only one whose sole parent is the current HEAD: the squashed export then
 * stays exactly one commit on HEAD instead of a chain of hand-offs.
 */
async function verifyStartAt(
	repositoryRoot: string,
	startAt: string,
	head: string,
	signal?: AbortSignal,
): Promise<void> {
	if ((await revParseCommit(repositoryRoot, startAt, signal)) !== startAt) {
		throw new WorkspacePreflightError(
			"workspace startAt commit does not exist in the repository",
		);
	}
	const refs = (
		await git(
			repositoryRoot,
			[
				"--no-replace-objects",
				"for-each-ref",
				"--format=%(refname)",
				`--points-at=${startAt}`,
				HANDOFF_REF_PREFIX,
			],
			signal,
		)
	)
		.toString("utf8")
		.split("\n")
		.filter(Boolean);
	const handoffRef = new RegExp(HANDOFF_REF_PATTERN);
	if (!refs.some((ref) => handoffRef.test(ref))) {
		throw new WorkspacePreflightError(
			"workspace startAt is not the target of a hand-off ref in this repository",
		);
	}
	const parents = (
		await git(
			repositoryRoot,
			["--no-replace-objects", "rev-list", "--parents", "-n1", startAt],
			signal,
		)
	)
		.toString("utf8")
		.trim()
		.split(/\s+/);
	if (parents.length !== 2 || parents[1] !== head) {
		throw new WorkspacePreflightError(
			"workspace startAt must have exactly one parent, the repository HEAD",
		);
	}
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
	const startAt = request.startAt;
	if (startAt !== undefined) {
		await verifyStartAt(canonicalRoot, startAt, head, signal);
	}
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
		baselineSha256 = canonicalSha256({
			head,
			...(startAt ? { startAt } : {}),
		});
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
			...(startAt ? { startAt } : {}),
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
		...(startAt ? { startAt } : {}),
	};
}
