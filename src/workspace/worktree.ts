import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	mkdir,
	open,
	readFile,
	realpath,
	rename,
	stat,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
	type AttemptId,
	AttemptIdSchema,
	assertContractRevision,
	CONTRACT_REVISION,
	type RunId,
	RunIdSchema,
} from "../contracts.js";
import type { RunLease } from "../persistence/run-lease.js";
import type { WorkspacePreflight } from "../preflight/workspace.js";

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT = 64 * 1024 * 1024;

export const WorktreeRecordSchema = Type.Object(
	{
		schema: Type.Literal("pi-subagent-worktree"),
		contractRevision: Type.Literal(CONTRACT_REVISION),
		runId: RunIdSchema,
		attemptId: AttemptIdSchema,
		repositoryRoot: Type.String({ minLength: 1, maxLength: 4096 }),
		worktreePath: Type.String({ minLength: 1, maxLength: 4096 }),
		recordPath: Type.String({ minLength: 1, maxLength: 4096 }),
		branch: Type.String({ minLength: 1, maxLength: 1024 }),
		baselineHead: Type.String({ pattern: "^[a-f0-9]{40,64}$" }),
		createdAt: Type.String({ format: "date-time" }),
		handoffCommit: Type.Optional(Type.String({ pattern: "^[a-f0-9]{40,64}$" })),
		releasedAt: Type.Optional(Type.String({ format: "date-time" })),
	},
	{ additionalProperties: false },
);

export type WorktreeRecord = {
	schema: "pi-subagent-worktree";
	contractRevision: typeof CONTRACT_REVISION;
	runId: RunId;
	attemptId: AttemptId;
	repositoryRoot: string;
	worktreePath: string;
	recordPath: string;
	branch: string;
	baselineHead: string;
	createdAt: string;
	handoffCommit?: string;
	releasedAt?: string;
};

export type WorktreeObservation = {
	state: "absent" | "clean" | "dirty" | "branch-retained" | "unknown";
	reason?: string;
};

export class WorktreeNoChangesError extends Error {
	constructor() {
		super("worktree has no changes to hand off");
		this.name = "WorktreeNoChangesError";
	}
}

export class WorktreeError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "WorktreeError";
	}
}

function gitEnvironment(): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {
		GIT_AUTHOR_EMAIL: "pi-subagent@localhost",
		GIT_AUTHOR_NAME: "pi-subagent",
		GIT_COMMITTER_EMAIL: "pi-subagent@localhost",
		GIT_COMMITTER_NAME: "pi-subagent",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_TERMINAL_PROMPT: "0",
	};
	for (const key of ["LANG", "LC_ALL", "PATH", "TMPDIR"] as const) {
		const value = process.env[key];
		if (value) environment[key] = value;
	}
	return environment;
}

async function git(cwd: string, args: string[]): Promise<Buffer> {
	try {
		const result = await execFileAsync(
			"git",
			[
				"-c",
				"commit.gpgSign=false",
				"-c",
				"core.fsmonitor=false",
				"-c",
				"core.hooksPath=/dev/null",
				...args,
			],
			{
				cwd,
				encoding: "buffer",
				maxBuffer: MAX_GIT_OUTPUT,
				env: gitEnvironment(),
			},
		);
		return result.stdout;
	} catch (error) {
		throw new WorktreeError(
			`git worktree operation failed: git ${args.join(" ")}`,
			{
				cause: error,
			},
		);
	}
}

async function syncDirectory(directory: string): Promise<void> {
	const handle = await open(directory, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function writeRecord(filePath: string, record: WorktreeRecord) {
	if (!Value.Check(WorktreeRecordSchema, record)) {
		throw new WorktreeError("invalid worktree record");
	}
	const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
	const handle = await open(temporary, "wx", 0o600);
	try {
		await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	await rename(temporary, filePath);
	await syncDirectory(path.dirname(filePath));
}

function identitySegment(value: string, length: number): string {
	return createHash("sha256").update(value).digest("hex").slice(0, length);
}

export async function createAttemptWorktree(options: {
	root: string;
	runId: RunId;
	attemptId: AttemptId;
	workspace: WorkspacePreflight;
	lease: RunLease;
}): Promise<WorktreeRecord> {
	if (options.lease.record.runId !== options.runId) {
		throw new WorktreeError("worktree run lease identity mismatch");
	}
	await options.lease.assertCurrent();
	if (options.workspace.mode !== "worktree" || options.workspace.dirty) {
		throw new WorktreeError(
			"writing worktree requires a clean worktree preflight",
		);
	}
	await mkdir(options.root, { recursive: true, mode: 0o700 });
	const root = await realpath(options.root);
	const worktreesRoot = path.join(root, "worktrees");
	const recordsRoot = path.join(root, "records");
	await mkdir(worktreesRoot, { recursive: true, mode: 0o700 });
	await mkdir(recordsRoot, { recursive: true, mode: 0o700 });
	const worktreePath = path.join(worktreesRoot, options.attemptId);
	const branch = `pi-subagent/${identitySegment(options.runId, 16)}/${identitySegment(options.attemptId, 32)}`;
	const recordPath = path.join(recordsRoot, `${options.attemptId}.json`);
	const record: WorktreeRecord = {
		schema: "pi-subagent-worktree",
		contractRevision: CONTRACT_REVISION,
		runId: options.runId,
		attemptId: options.attemptId,
		repositoryRoot: options.workspace.repositoryRoot,
		worktreePath,
		recordPath,
		branch,
		baselineHead: options.workspace.head,
		createdAt: new Date().toISOString(),
	};
	const reservation = await open(recordPath, "wx", 0o600).catch((error) => {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			throw new WorktreeError("worktree attempt is already reserved");
		}
		throw error;
	});
	await reservation.close();
	try {
		await options.lease.assertCurrent();
		await git(options.workspace.repositoryRoot, [
			"worktree",
			"add",
			"-b",
			branch,
			worktreePath,
			options.workspace.head,
		]);
		await options.lease.assertCurrent();
		await writeRecord(recordPath, record);
		return record;
	} catch (error) {
		throw new WorktreeError("worktree creation requires reconciliation", {
			cause: error,
		});
	}
}

export async function captureWorktreeHandoff(
	record: WorktreeRecord,
	message: string,
	lease: RunLease,
): Promise<WorktreeRecord> {
	if (lease.record.runId !== record.runId) {
		throw new WorktreeError("worktree run lease identity mismatch");
	}
	await lease.assertCurrent();
	if (!message.trim() || message.length > 512) {
		throw new WorktreeError(
			"handoff commit message must contain 1-512 characters",
		);
	}
	if (record.handoffCommit) {
		throw new WorktreeError("worktree handoff already captured");
	}
	const canonicalWorktree = await realpath(record.worktreePath);
	if (canonicalWorktree !== record.worktreePath) {
		throw new WorktreeError("worktree path identity mismatch");
	}
	const worktreeRoot = (
		await git(record.worktreePath, ["rev-parse", "--show-toplevel"])
	)
		.toString("utf8")
		.trim();
	const branch = (await git(record.worktreePath, ["branch", "--show-current"]))
		.toString("utf8")
		.trim();
	const head = (await git(record.worktreePath, ["rev-parse", "HEAD"]))
		.toString("utf8")
		.trim();
	if (
		worktreeRoot !== record.worktreePath ||
		branch !== record.branch ||
		head !== record.baselineHead
	) {
		throw new WorktreeError("worktree baseline identity mismatch");
	}
	await git(record.worktreePath, ["add", "-A"]);
	const staged = await git(record.worktreePath, ["diff", "--cached", "--quiet"])
		.then(() => false)
		.catch(() => true);
	if (!staged) throw new WorktreeNoChangesError();
	await git(record.worktreePath, ["commit", "-m", message]);
	const handoffCommit = (
		await git(record.worktreePath, ["rev-parse", "--verify", "HEAD"])
	)
		.toString("utf8")
		.trim();
	const updated = { ...record, handoffCommit };
	await lease.assertCurrent();
	await writeRecord(record.recordPath, updated);
	return updated;
}

export async function finalizeWorktreeHandoff(
	record: WorktreeRecord,
	message: string,
	lease: RunLease,
): Promise<WorktreeRecord | undefined> {
	let handoff: WorktreeRecord | undefined;
	try {
		handoff = await captureWorktreeHandoff(record, message, lease);
	} catch (error) {
		if (!(error instanceof WorktreeNoChangesError)) throw error;
	}
	await removeCleanWorktree(handoff ?? record, lease);
	return handoff;
}

export async function removeCleanWorktree(
	record: WorktreeRecord,
	lease: RunLease,
): Promise<void> {
	if (lease.record.runId !== record.runId) {
		throw new WorktreeError("worktree run lease identity mismatch");
	}
	await lease.assertCurrent();
	const metadata = await stat(record.worktreePath);
	if (!metadata.isDirectory())
		throw new WorktreeError("worktree path is not a directory");
	const canonicalWorktree = await realpath(record.worktreePath);
	if (canonicalWorktree !== record.worktreePath) {
		throw new WorktreeError("worktree path identity mismatch");
	}
	const status = await git(record.worktreePath, [
		"status",
		"--porcelain=v1",
		"-z",
	]);
	if (status.byteLength > 0)
		throw new WorktreeError("dirty worktree is retained");
	const worktreeRoot = (
		await git(record.worktreePath, ["rev-parse", "--show-toplevel"])
	)
		.toString("utf8")
		.trim();
	const branch = (await git(record.worktreePath, ["branch", "--show-current"]))
		.toString("utf8")
		.trim();
	const head = (await git(record.worktreePath, ["rev-parse", "HEAD"]))
		.toString("utf8")
		.trim();
	if (
		worktreeRoot !== record.worktreePath ||
		branch !== record.branch ||
		head !== (record.handoffCommit ?? record.baselineHead)
	) {
		throw new WorktreeError("worktree cleanup identity mismatch");
	}
	await lease.assertCurrent();
	await git(record.repositoryRoot, ["worktree", "remove", record.worktreePath]);
}

export async function releaseWorktreeBranch(
	record: WorktreeRecord,
	lease: RunLease,
): Promise<WorktreeRecord> {
	if (lease.record.runId !== record.runId) {
		throw new WorktreeError("worktree run lease identity mismatch");
	}
	await lease.assertCurrent();
	try {
		await stat(record.worktreePath);
		throw new WorktreeError("worktree must be removed before branch release");
	} catch (error) {
		if (error instanceof WorktreeError) throw error;
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const listed = (
		await git(record.repositoryRoot, ["branch", "--list", record.branch])
	)
		.toString("utf8")
		.trim();
	if (listed) {
		const branchCommit = (
			await git(record.repositoryRoot, ["rev-parse", "--verify", record.branch])
		)
			.toString("utf8")
			.trim();
		if (branchCommit !== (record.handoffCommit ?? record.baselineHead)) {
			throw new WorktreeError("handoff branch identity mismatch");
		}
		await lease.assertCurrent();
		await git(record.repositoryRoot, ["branch", "-D", record.branch]);
	}
	const released = { ...record, releasedAt: new Date().toISOString() };
	await lease.assertCurrent();
	await writeRecord(record.recordPath, released);
	return released;
}

export async function observeWorktree(
	record: WorktreeRecord,
): Promise<WorktreeObservation> {
	let worktreeExists = true;
	try {
		const metadata = await stat(record.worktreePath);
		if (!metadata.isDirectory()) {
			return { state: "unknown", reason: "worktree path is not a directory" };
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			worktreeExists = false;
		} else {
			return { state: "unknown", reason: "worktree path observation failed" };
		}
	}
	const expectedHead = record.handoffCommit ?? record.baselineHead;
	if (!worktreeExists) {
		try {
			const listed = (
				await git(record.repositoryRoot, ["branch", "--list", record.branch])
			)
				.toString("utf8")
				.trim();
			if (!listed) {
				return record.releasedAt
					? { state: "absent" }
					: { state: "unknown", reason: "branch disappeared without release" };
			}
			const branchHead = (
				await git(record.repositoryRoot, [
					"rev-parse",
					"--verify",
					record.branch,
				])
			)
				.toString("utf8")
				.trim();
			return branchHead === expectedHead
				? { state: "branch-retained" }
				: { state: "unknown", reason: "retained branch identity mismatch" };
		} catch {
			return { state: "unknown", reason: "retained branch observation failed" };
		}
	}
	try {
		const canonicalWorktree = await realpath(record.worktreePath);
		const worktreeRoot = (
			await git(record.worktreePath, ["rev-parse", "--show-toplevel"])
		)
			.toString("utf8")
			.trim();
		const branch = (
			await git(record.worktreePath, ["branch", "--show-current"])
		)
			.toString("utf8")
			.trim();
		const head = (
			await git(record.worktreePath, ["rev-parse", "--verify", "HEAD"])
		)
			.toString("utf8")
			.trim();
		if (
			canonicalWorktree !== record.worktreePath ||
			worktreeRoot !== record.worktreePath ||
			branch !== record.branch ||
			head !== expectedHead
		) {
			return { state: "unknown", reason: "worktree identity mismatch" };
		}
		const status = await git(record.worktreePath, [
			"status",
			"--porcelain=v1",
			"-z",
		]);
		return { state: status.byteLength > 0 ? "dirty" : "clean" };
	} catch {
		return { state: "unknown", reason: "worktree inspection failed" };
	}
}

export async function readWorktreeRecord(
	filePath: string,
): Promise<WorktreeRecord> {
	const value = JSON.parse(await readFile(filePath, "utf8")) as unknown;
	assertContractRevision(value, "worktree record");
	if (!Value.Check(WorktreeRecordSchema, value)) {
		throw new WorktreeError("invalid worktree record");
	}
	return value as WorktreeRecord;
}
