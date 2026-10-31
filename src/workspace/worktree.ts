import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	mkdir,
	open,
	readdir,
	readFile,
	realpath,
	rename,
	stat,
	unlink,
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
	HANDOFF_EXPORT_MEDIA_TYPE,
	type HandoffRef,
	HandoffRefSchema,
	type RunId,
	RunIdSchema,
} from "../contracts.js";
import type { RunLease } from "../persistence/run-lease.js";
import type { WorkspacePreflight } from "../preflight/workspace.js";

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT = 64 * 1024 * 1024;
/**
 * Absolute handoff export cap. It equals the bounded stdout buffer used for
 * every authoritative Git operation, so an export can never require more
 * host memory than any other Git evidence read. Consumers importing bounded
 * evidence pass a smaller `maxBytes`; larger handoffs are not exportable.
 */
export const MAX_HANDOFF_EXPORT_BYTES = MAX_GIT_OUTPUT;
export const HANDOFF_REF_PREFIX = "refs/pi-subagent/handoffs/";
export const HANDOFF_REF_PATTERN =
	"^refs/pi-subagent/handoffs/run_[a-z0-9]+/attempt_[a-z0-9]+$";
/**
 * Fixed `git format-patch` configuration. Every option that repository-local
 * `format.*` or `diff.*` configuration could otherwise change is pinned so the
 * same baseline/handoff pair yields identical bytes. The trailing Git version
 * signature and the diffstat are omitted because they depend on the host
 * build and rendering width rather than on the commit pair.
 */
const FORMAT_PATCH_ARGUMENTS = [
	"-c",
	"format.mboxrd=false",
	"-c",
	"diff.suppressBlankEmpty=false",
	"-c",
	"core.quotePath=true",
	"-c",
	"i18n.logOutputEncoding=UTF-8",
	"format-patch",
	"--stdout",
	"--binary",
	"--full-index",
	"--no-stat",
	"--no-signature",
	"--no-color",
	"--no-ext-diff",
	"--no-textconv",
	"--no-attach",
	"--no-thread",
	"--no-cover-letter",
	"--no-numbered",
	"--no-signoff",
	"--no-cc",
	"--no-to",
	"--no-add-header",
	"--no-encode-email-headers",
	"--no-notes",
	"--no-base",
	"--no-from",
	"--no-force-in-body-from",
	"--subject-prefix=PATCH",
	"--diff-algorithm=myers",
	"--no-indent-heuristic",
	"--unified=3",
	"--inter-hunk-context=0",
	"--src-prefix=a/",
	"--dst-prefix=b/",
	"--no-relative",
	"--find-renames",
	"-l1000",
	"-O/dev/null",
] as const;

export function handoffRefName(runId: RunId, attemptId: AttemptId): string {
	return `${HANDOFF_REF_PREFIX}${runId}/${attemptId}`;
}

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
		startCommit: Type.Optional(Type.String({ pattern: "^[a-f0-9]{40,64}$" })),
		createdAt: Type.String({ format: "date-time" }),
		handoffCommit: Type.Optional(Type.String({ pattern: "^[a-f0-9]{40,64}$" })),
		handoffRef: Type.Optional(
			Type.String({ pattern: HANDOFF_REF_PATTERN, maxLength: 1024 }),
		),
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
	/**
	 * The hand-off commit the worktree was checked out at, when not HEAD: the
	 * workspace's `startAt`, or the run's own hand-off a resume continues from.
	 */
	startCommit?: string;
	createdAt: string;
	handoffCommit?: string;
	handoffRef?: string;
	releasedAt?: string;
};

export type HandoffExport = {
	ref: HandoffRef;
	content: Buffer;
};

export type HandoffRefTarget = {
	runId: RunId;
	repositoryRoot: string;
	ref: string;
	commit?: string;
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

export function gitEnvironment(): NodeJS.ProcessEnv {
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

async function git(
	cwd: string,
	args: readonly string[],
	options: { maxBuffer?: number } = {},
): Promise<Buffer> {
	try {
		const result = await execFileAsync(
			"git",
			[
				"--no-replace-objects",
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
				maxBuffer: options.maxBuffer ?? MAX_GIT_OUTPUT,
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

function exceededOutputBuffer(error: unknown): boolean {
	const cause = (error as { cause?: { code?: unknown } }).cause;
	return cause?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
}

async function resolveHandoffRef(
	repositoryRoot: string,
	ref: string,
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
					`${ref}^{commit}`,
				],
				{
					cwd: repositoryRoot,
					encoding: "utf8",
					maxBuffer: 4096,
					env: gitEnvironment(),
				},
			)
		).stdout.trim();
	} catch (error) {
		// `rev-parse --verify --quiet` exits 1 with empty stderr only for a
		// missing ref. A non-repository, corrupt ref storage, or any other
		// failure exits 128 and must fail closed rather than read as "absent".
		const failure = error as { code?: unknown; stderr?: unknown };
		if (failure.code === 1 && failure.stderr === "") return undefined;
		throw new WorktreeError(`handoff ref lookup failed: ${ref}`, {
			cause: error,
		});
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

/** The commit the worktree branch holds before any hand-off is captured. */
function startCommit(record: WorktreeRecord): string {
	return record.startCommit ?? record.baselineHead;
}

/** The commit the worktree branch holds now: the hand-off once captured. */
function expectedHead(record: WorktreeRecord): string {
	return record.handoffCommit ?? startCommit(record);
}

function identitySegment(value: string, length: number): string {
	return createHash("sha256").update(value).digest("hex").slice(0, length);
}

/**
 * A worktree that continues a run from its own hand-off starts at that
 * hand-off but keeps the hand-off's baseline, so its capture squashes onto the
 * same baseline and replaces the earlier hand-off rather than stacking on it.
 */
async function continuedStartCommit(
	runId: RunId,
	workspace: WorkspacePreflight,
	handoff: WorktreeRecord,
): Promise<string> {
	if (handoff.runId !== runId || !handoff.handoffCommit) {
		throw new WorktreeError("continued hand-off does not belong to this run");
	}
	if (handoff.baselineHead !== workspace.head) {
		throw new WorktreeError(
			"repository HEAD is not the baseline of the hand-off being continued",
		);
	}
	await assertHandoffReachable(handoff);
	return handoff.handoffCommit;
}

export async function createAttemptWorktree(options: {
	root: string;
	runId: RunId;
	attemptId: AttemptId;
	workspace: WorkspacePreflight;
	lease: RunLease;
	/** The run's own hand-off this attempt continues from, in place of `startAt`. */
	continueFrom?: WorktreeRecord;
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
	const start = options.continueFrom
		? await continuedStartCommit(
				options.runId,
				options.workspace,
				options.continueFrom,
			)
		: options.workspace.startAt;
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
		...(start ? { startCommit: start } : {}),
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
			startCommit(record),
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
		head !== startCommit(record)
	) {
		throw new WorktreeError("worktree baseline identity mismatch");
	}
	const handoffRef = handoffRefName(record.runId, record.attemptId);
	if (
		(await resolveHandoffRef(record.repositoryRoot, handoffRef)) !== undefined
	) {
		// No commit exists yet, so any ref at this attempt's deterministic name
		// is foreign; refuse before touching the worktree history.
		throw new WorktreeError("handoff ref already exists");
	}
	await git(record.worktreePath, ["add", "-A"]);
	const staged = await git(record.worktreePath, ["diff", "--cached", "--quiet"])
		.then(() => false)
		.catch(() => true);
	if (!staged) throw new WorktreeNoChangesError();
	// The hand-off is squashed onto the baseline whatever commit the worktree
	// started at, so it stays exactly one commit on the repository HEAD.
	const tree = (await git(record.worktreePath, ["write-tree"]))
		.toString("utf8")
		.trim();
	const baselineTree = (
		await git(record.worktreePath, [
			"rev-parse",
			"--verify",
			`${record.baselineHead}^{tree}`,
		])
	)
		.toString("utf8")
		.trim();
	if (tree === baselineTree) {
		throw new WorktreeError(
			"worktree reverted the hand-off it started at; its final tree equals the baseline",
		);
	}
	const handoffCommit = (
		await git(record.worktreePath, [
			"commit-tree",
			tree,
			"-p",
			record.baselineHead,
			"-m",
			message,
		])
	)
		.toString("utf8")
		.trim();
	await git(record.worktreePath, [
		"update-ref",
		`refs/heads/${record.branch}`,
		handoffCommit,
		startCommit(record),
	]);
	await lease.assertCurrent();
	try {
		await git(record.repositoryRoot, [
			"update-ref",
			handoffRef,
			handoffCommit,
			"",
		]);
	} catch (error) {
		// Idempotent: a ref already pinning this exact commit is accepted.
		const current = await resolveHandoffRef(record.repositoryRoot, handoffRef);
		if (current !== handoffCommit) {
			throw new WorktreeError("handoff ref identity mismatch", {
				cause: error,
			});
		}
	}
	const updated = { ...record, handoffCommit, handoffRef };
	await lease.assertCurrent();
	await writeRecord(record.recordPath, updated);
	return updated;
}

async function assertHandoffReachable(record: WorktreeRecord): Promise<void> {
	if (!record.handoffCommit) return;
	if (!record.handoffRef) {
		throw new WorktreeError("handoff commit has no durable handoff ref");
	}
	const current = await resolveHandoffRef(
		record.repositoryRoot,
		record.handoffRef,
	);
	if (current !== record.handoffCommit) {
		throw new WorktreeError(
			"handoff commit is not reachable from its durable handoff ref",
		);
	}
}

export async function exportWorktreeHandoff(
	record: WorktreeRecord,
	options: { lease: RunLease; maxBytes?: number },
): Promise<HandoffExport> {
	if (options.lease.record.runId !== record.runId) {
		throw new WorktreeError("worktree run lease identity mismatch");
	}
	await options.lease.assertCurrent();
	const maxBytes = options.maxBytes ?? MAX_HANDOFF_EXPORT_BYTES;
	if (
		!Number.isSafeInteger(maxBytes) ||
		maxBytes < 1 ||
		maxBytes > MAX_HANDOFF_EXPORT_BYTES
	) {
		throw new WorktreeError(
			`handoff export limit must be an integer from 1 to ${MAX_HANDOFF_EXPORT_BYTES}`,
		);
	}
	if (!record.handoffCommit) {
		throw new WorktreeError("worktree has no handoff commit to export");
	}
	if (record.handoffCommit === record.baselineHead) {
		throw new WorktreeError(
			"handoff commit equals its baseline; there is no handoff to export",
		);
	}
	await assertHandoffReachable(record);
	const parents = (
		await git(record.repositoryRoot, [
			"rev-list",
			"--parents",
			"-n1",
			record.handoffCommit,
		])
	)
		.toString("utf8")
		.trim()
		.split(/\s+/);
	if (
		parents.length !== 2 ||
		parents[0] !== record.handoffCommit ||
		parents[1] !== record.baselineHead
	) {
		throw new WorktreeError(
			"handoff commit must have exactly one parent, the recorded baseline",
		);
	}
	const count = (
		await git(record.repositoryRoot, [
			"rev-list",
			"--count",
			`${record.baselineHead}..${record.handoffCommit}`,
		])
	)
		.toString("utf8")
		.trim();
	if (count !== "1") {
		throw new WorktreeError(
			"handoff must be exactly one commit on top of its baseline",
		);
	}
	await options.lease.assertCurrent();
	let content: Buffer;
	try {
		content = await git(
			record.repositoryRoot,
			[
				...FORMAT_PATCH_ARGUMENTS,
				`${record.baselineHead}..${record.handoffCommit}`,
			],
			{ maxBuffer: maxBytes },
		);
	} catch (error) {
		if (exceededOutputBuffer(error)) {
			throw new WorktreeError("handoff export exceeds byte limit", {
				cause: error,
			});
		}
		throw error;
	}
	if (content.byteLength > maxBytes) {
		throw new WorktreeError("handoff export exceeds byte limit");
	}
	if (content.byteLength === 0) {
		throw new WorktreeError("handoff export produced no patch content");
	}
	const ref: HandoffRef = {
		runId: record.runId,
		attemptId: record.attemptId,
		baselineHead: record.baselineHead,
		handoffCommit: record.handoffCommit,
		format: "git-format-patch",
		sha256: createHash("sha256").update(content).digest("hex"),
		bytes: content.byteLength,
		mediaType: HANDOFF_EXPORT_MEDIA_TYPE,
	};
	if (!Value.Check(HandoffRefSchema, ref)) {
		throw new WorktreeError("invalid handoff export metadata");
	}
	return { ref, content };
}

/**
 * The ref name is deterministic from run and attempt identity, so retention can
 * reclaim a ref created in the crash window between `update-ref` and the record
 * write even when the record never learned about it. Without a recorded commit
 * the ref is removed unconditionally; with one, only when it still resolves
 * to that commit.
 */
export function handoffRefTarget(record: WorktreeRecord): HandoffRefTarget {
	return {
		runId: record.runId,
		repositoryRoot: record.repositoryRoot,
		ref: record.handoffRef ?? handoffRefName(record.runId, record.attemptId),
		...(record.handoffCommit ? { commit: record.handoffCommit } : {}),
	};
}

export type HandoffRefState = "present" | "absent" | "repository-missing";

export async function inspectHandoffRef(
	target: HandoffRefTarget,
): Promise<HandoffRefState> {
	try {
		const metadata = await stat(target.repositoryRoot);
		if (!metadata.isDirectory()) {
			throw new WorktreeError("handoff repository root is not a directory");
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return "repository-missing";
		}
		throw error;
	}
	const current = await resolveHandoffRef(target.repositoryRoot, target.ref);
	if (current === undefined) return "absent";
	if (target.commit !== undefined && current !== target.commit) {
		throw new WorktreeError("handoff ref identity mismatch");
	}
	return "present";
}

export async function removeHandoffRef(
	target: HandoffRefTarget,
	lease: RunLease,
): Promise<HandoffRefState> {
	if (lease.record.runId !== target.runId) {
		throw new WorktreeError("handoff ref run lease identity mismatch");
	}
	await lease.assertCurrent();
	const state = await inspectHandoffRef(target);
	if (state !== "present") return state;
	await lease.assertCurrent();
	await git(target.repositoryRoot, [
		"update-ref",
		"-d",
		target.ref,
		...(target.commit === undefined ? [] : [target.commit]),
	]);
	return "present";
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
		head !== expectedHead(record)
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
	await assertHandoffReachable(record);
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
		if (branchCommit !== expectedHead(record)) {
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
	const expected = expectedHead(record);
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
			return branchHead === expected
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
			head !== expected
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

export const SnapshotRecordSchema = Type.Object(
	{
		schema: Type.Literal("pi-subagent-snapshot"),
		contractRevision: Type.Literal(CONTRACT_REVISION),
		runId: RunIdSchema,
		attemptId: AttemptIdSchema,
		repositoryRoot: Type.String({ minLength: 1, maxLength: 4096 }),
		snapshotPath: Type.String({ minLength: 1, maxLength: 4096 }),
		recordPath: Type.String({ minLength: 1, maxLength: 4096 }),
		commit: Type.String({ pattern: "^[a-f0-9]{40,64}$" }),
		createdAt: Type.String({ format: "date-time" }),
	},
	{ additionalProperties: false },
);

/**
 * A detached, read-only checkout of the hand-off commit a read-only attempt
 * starts at. It has no branch and never yields a hand-off; it lives exactly
 * as long as the attempt that mounts it.
 */
export type SnapshotRecord = {
	schema: "pi-subagent-snapshot";
	contractRevision: typeof CONTRACT_REVISION;
	runId: RunId;
	attemptId: AttemptId;
	repositoryRoot: string;
	snapshotPath: string;
	recordPath: string;
	commit: string;
	createdAt: string;
};

function snapshotRoots(root: string): { trees: string; records: string } {
	return {
		trees: path.join(root, "snapshots", "trees"),
		records: path.join(root, "snapshots", "records"),
	};
}

export async function createReadOnlySnapshot(options: {
	root: string;
	runId: RunId;
	attemptId: AttemptId;
	workspace: WorkspacePreflight;
	lease: RunLease;
}): Promise<SnapshotRecord> {
	if (options.lease.record.runId !== options.runId) {
		throw new WorktreeError("snapshot run lease identity mismatch");
	}
	await options.lease.assertCurrent();
	const commit = options.workspace.startAt;
	if (options.workspace.mode !== "read-only" || commit === undefined) {
		throw new WorktreeError(
			"read-only snapshot requires a read-only preflight with startAt",
		);
	}
	await mkdir(options.root, { recursive: true, mode: 0o700 });
	const roots = snapshotRoots(await realpath(options.root));
	await mkdir(roots.trees, { recursive: true, mode: 0o700 });
	await mkdir(roots.records, { recursive: true, mode: 0o700 });
	const recordPath = path.join(roots.records, `${options.attemptId}.json`);
	const record: SnapshotRecord = {
		schema: "pi-subagent-snapshot",
		contractRevision: CONTRACT_REVISION,
		runId: options.runId,
		attemptId: options.attemptId,
		repositoryRoot: options.workspace.repositoryRoot,
		snapshotPath: path.join(roots.trees, options.attemptId),
		recordPath,
		commit,
		createdAt: new Date().toISOString(),
	};
	if (!Value.Check(SnapshotRecordSchema, record)) {
		throw new WorktreeError("invalid snapshot record");
	}
	// The record is durable before the checkout exists, so a crash between the
	// two leaves evidence that reconciliation can act on.
	const handle = await open(recordPath, "wx", 0o600).catch((error) => {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			throw new WorktreeError("snapshot attempt is already reserved");
		}
		throw error;
	});
	try {
		await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	await syncDirectory(roots.records);
	try {
		await options.lease.assertCurrent();
		await git(record.repositoryRoot, [
			"worktree",
			"add",
			"--detach",
			record.snapshotPath,
			record.commit,
		]);
	} catch (error) {
		throw new WorktreeError("snapshot creation requires reconciliation", {
			cause: error,
		});
	}
	return record;
}

async function registeredWorktree(
	repositoryRoot: string,
	worktreePath: string,
): Promise<boolean> {
	const listing = (
		await git(repositoryRoot, ["worktree", "list", "--porcelain", "-z"])
	).toString("utf8");
	return listing.split("\0").includes(`worktree ${worktreePath}`);
}

/**
 * Removes a snapshot only once it is proved to be the recorded detached,
 * unmodified checkout. Idempotent: a snapshot already gone only loses its
 * stale Git registration and its record.
 */
export async function removeReadOnlySnapshot(
	record: SnapshotRecord,
	lease: RunLease,
): Promise<void> {
	if (lease.record.runId !== record.runId) {
		throw new WorktreeError("snapshot run lease identity mismatch");
	}
	await lease.assertCurrent();
	let present = true;
	try {
		if (!(await stat(record.snapshotPath)).isDirectory()) {
			throw new WorktreeError("snapshot path is not a directory");
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		present = false;
	}
	if (present) {
		if ((await realpath(record.snapshotPath)) !== record.snapshotPath) {
			throw new WorktreeError("snapshot path identity mismatch");
		}
		const root = (
			await git(record.snapshotPath, ["rev-parse", "--show-toplevel"])
		)
			.toString("utf8")
			.trim();
		const branch = (
			await git(record.snapshotPath, ["branch", "--show-current"])
		)
			.toString("utf8")
			.trim();
		const head = (
			await git(record.snapshotPath, ["rev-parse", "--verify", "HEAD"])
		)
			.toString("utf8")
			.trim();
		if (
			root !== record.snapshotPath ||
			branch !== "" ||
			head !== record.commit
		) {
			throw new WorktreeError("snapshot identity mismatch");
		}
		const status = await git(record.snapshotPath, [
			"status",
			"--porcelain=v1",
			"-z",
		]);
		if (status.byteLength > 0) {
			throw new WorktreeError("modified snapshot is retained");
		}
		await lease.assertCurrent();
		await git(record.repositoryRoot, [
			"worktree",
			"remove",
			record.snapshotPath,
		]);
	} else if (
		await registeredWorktree(record.repositoryRoot, record.snapshotPath)
	) {
		await lease.assertCurrent();
		await git(record.repositoryRoot, [
			"worktree",
			"remove",
			"--force",
			record.snapshotPath,
		]);
	}
	await unlink(record.recordPath).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "ENOENT") throw error;
	});
	await syncDirectory(path.dirname(record.recordPath));
}

export async function readSnapshotRecord(
	filePath: string,
): Promise<SnapshotRecord> {
	const value = JSON.parse(await readFile(filePath, "utf8")) as unknown;
	assertContractRevision(value, "snapshot record");
	if (!Value.Check(SnapshotRecordSchema, value)) {
		throw new WorktreeError("invalid snapshot record");
	}
	const record = value as SnapshotRecord;
	if (record.recordPath !== filePath) {
		throw new WorktreeError("snapshot record path identity mismatch");
	}
	return record;
}

/** Snapshot records a run still holds, for reconciliation after a crash. */
export async function listRunSnapshots(
	root: string,
	runId: RunId,
): Promise<SnapshotRecord[]> {
	let entries: string[];
	let records: string;
	try {
		records = snapshotRoots(await realpath(root)).records;
		entries = await readdir(records);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const owned: SnapshotRecord[] = [];
	for (const entry of entries.sort()) {
		if (!entry.endsWith(".json")) continue;
		const record = await readSnapshotRecord(path.join(records, entry));
		if (record.runId === runId) owned.push(record);
	}
	return owned;
}
