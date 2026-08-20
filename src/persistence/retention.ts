import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
	chmod,
	link,
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	realpath,
	rename,
	stat,
	unlink,
} from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import {
	AttemptIdSchema,
	assertContractRevision,
	CONTRACT_REVISION,
	type RunId,
	RunIdSchema,
	type RunStatus,
	RunStatusSchema,
} from "../contracts.js";
import { OperationRecordSchema } from "./operation-index.js";
import {
	acquireRunLease,
	type RunLease,
	RunLeaseUnavailableError,
} from "./run-lease.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_AGE_MS = 30 * DAY_MS;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_PIN_BYTES = 16 * 1024;
const ORDINARY_TERMINAL = new Set<RunStatus>([
	"completed",
	"failed",
	"cancelled",
	"abandoned",
]);

export const RetentionPinSchema = Type.Object(
	{
		schema: Type.Literal("pi-subagent-retention-pin"),
		contractRevision: Type.Literal(CONTRACT_REVISION),
		runId: RunIdSchema,
		ownerId: Type.String({ minLength: 1, maxLength: 256 }),
		reason: Type.String({ minLength: 1, maxLength: 512 }),
		createdAt: Type.String({ format: "date-time" }),
	},
	{ additionalProperties: false },
);
export type RetentionPin = Static<typeof RetentionPinSchema>;

export type RetentionRun = {
	runId: RunId;
	status: RunStatus;
	terminalAt?: string;
	attemptIds: string[];
	worktreeAttemptIds: string[];
	retainedWorktree: boolean;
};

export type RetentionRunReport = {
	runId: RunId;
	status: RunStatus;
	bytes: number;
	terminalAt?: string;
	reasons: string[];
	trashPath?: string;
};

export type RetentionReport = {
	dryRun: boolean;
	startedAt: string;
	completedAt: string;
	policy: { maxAgeMs: number; maxBytes: number };
	ordinaryBytesBefore: number;
	ordinaryBytesAfter: number;
	protected: RetentionRunReport[];
	selected: RetentionRunReport[];
	pruned: RetentionRunReport[];
	recoveredTrashIntents: RunId[];
};

export type RetentionManager = {
	root: string;
	trashRoot: string;
	pin(ownerId: string, runId: RunId, reason: string): Promise<RetentionPin>;
	unpin(ownerId: string, runId: RunId): Promise<boolean>;
	listPins(runId?: RunId): Promise<RetentionPin[]>;
	prune(options: {
		runs: RetentionRun[];
		dryRun: boolean;
		now?: Date;
		maxAgeMs?: number;
		maxBytes?: number;
	}): Promise<RetentionReport>;
};

export class RetentionLeaseUnavailableError extends Error {
	constructor() {
		super("retention lease unavailable");
		this.name = "RetentionLeaseUnavailableError";
	}
}

function pinKey(ownerId: string, runId: string): string {
	return createHash("sha256")
		.update(ownerId)
		.update("\0")
		.update(runId)
		.digest("hex");
}

function retentionPort(root: string): number {
	const value = createHash("sha256").update(root).digest().readUInt32BE(0);
	return 40_000 + (value % 2_000);
}

async function bindRetentionLease(root: string): Promise<() => Promise<void>> {
	const server = net.createServer((socket) => socket.destroy());
	try {
		await new Promise<void>((resolve, reject) => {
			const onError = (error: NodeJS.ErrnoException) => {
				server.off("listening", onListening);
				reject(error);
			};
			const onListening = () => {
				server.off("error", onError);
				resolve();
			};
			server.once("error", onError);
			server.once("listening", onListening);
			server.listen({
				host: "127.0.0.1",
				port: retentionPort(root),
				exclusive: true,
			});
		});
	} catch (error) {
		server.close();
		if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
			throw new RetentionLeaseUnavailableError();
		}
		throw error;
	}
	server.on("error", () => {});
	server.unref();
	let released = false;
	return async () => {
		if (released) return;
		released = true;
		if (!server.listening) return;
		await new Promise<void>((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()));
		});
	};
}

async function syncDirectory(directory: string): Promise<void> {
	const handle = await open(directory, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function writeDurable(filePath: string, content: string): Promise<void> {
	const handle = await open(filePath, "wx", 0o600);
	try {
		await handle.writeFile(content, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function readPin(filePath: string): Promise<RetentionPin> {
	const metadata = await stat(filePath);
	if (!metadata.isFile() || metadata.size > MAX_PIN_BYTES) {
		throw new Error("invalid retention pin file");
	}
	const value = JSON.parse(await readFile(filePath, "utf8")) as unknown;
	assertContractRevision(value, "retention pin");
	if (!Value.Check(RetentionPinSchema, value)) {
		throw new Error("invalid retention pin schema");
	}
	return value as RetentionPin;
}

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await lstat(filePath);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

async function treeBytes(filePath: string, seen: Set<string>): Promise<number> {
	let metadata: Stats;
	try {
		metadata = await lstat(filePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
		throw error;
	}
	const identity = `${metadata.dev}:${metadata.ino}`;
	if (seen.has(identity)) return 0;
	seen.add(identity);
	if (!metadata.isDirectory() || metadata.isSymbolicLink())
		return metadata.size;
	let bytes = metadata.size;
	for (const entry of await readdir(filePath)) {
		bytes += await treeBytes(path.join(filePath, entry), seen);
	}
	return bytes;
}

async function operationPathsByRun(
	root: string,
): Promise<Map<RunId, string[]>> {
	const directory = path.join(root, "operations");
	let entries: string[];
	try {
		entries = await readdir(directory);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
		throw error;
	}
	const matches = new Map<RunId, string[]>();
	for (const entry of entries) {
		if (!entry.endsWith(".json")) continue;
		const filePath = path.join(directory, entry);
		const metadata = await stat(filePath);
		if (!metadata.isFile() || metadata.size > MAX_PIN_BYTES) {
			throw new Error("invalid operation record during retention");
		}
		const value = JSON.parse(await readFile(filePath, "utf8")) as unknown;
		assertContractRevision(value, "retention operation record");
		if (!Value.Check(OperationRecordSchema, value)) {
			throw new Error("invalid operation record during retention");
		}
		const paths = matches.get(value.runId) ?? [];
		paths.push(filePath);
		matches.set(value.runId, paths);
	}
	return matches;
}

async function linkedPaths(
	root: string,
	run: RetentionRun,
	operationPaths: string[],
): Promise<string[]> {
	const paths = [
		path.join(root, "runs", run.runId),
		path.join(root, "run-records", `${run.runId}.json`),
		path.join(root, "attempt-records", run.runId),
		path.join(root, "leases", `${run.runId}.lease.json`),
	];
	for (const attemptId of run.attemptIds) {
		paths.push(path.join(root, "sessions", attemptId));
	}
	for (const worktreeAttemptId of run.worktreeAttemptIds) {
		paths.push(
			path.join(root, "workspace", "records", `${worktreeAttemptId}.json`),
		);
	}
	paths.push(...operationPaths);
	const unique: string[] = [];
	for (const candidate of new Set(paths)) {
		if (await pathExists(candidate)) unique.push(candidate);
	}
	return unique;
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

function relativeWithin(root: string, candidate: string): string {
	const relative = path.relative(root, candidate);
	if (
		!relative ||
		relative === ".." ||
		relative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relative)
	) {
		throw new Error("retention path escapes service root");
	}
	return relative;
}

type TrashManifest = {
	schema: "pi-subagent-retention-trash";
	contractRevision: number;
	runId: RunId;
	createdAt: string;
	commitPath: string;
	paths: string[];
};

function safeTrashRelative(value: string): boolean {
	return (
		value.length > 0 &&
		!path.isAbsolute(value) &&
		value !== ".." &&
		!value.startsWith(`..${path.sep}`)
	);
}

async function recoverTrashIntents(
	root: string,
	trashRoot: string,
): Promise<RunId[]> {
	const recovered: RunId[] = [];
	for (const entry of (await readdir(trashRoot)).sort()) {
		const trashPath = path.join(trashRoot, entry);
		if (!(await pathExists(path.join(trashPath, "manifest.json")))) continue;
		if (await pathExists(path.join(trashPath, "completed.json"))) continue;
		let manifest: TrashManifest;
		try {
			manifest = JSON.parse(
				await readFile(path.join(trashPath, "manifest.json"), "utf8"),
			) as TrashManifest;
		} catch {
			throw new Error("invalid retention trash manifest JSON");
		}
		assertContractRevision(manifest, "retention trash manifest");
		if (
			manifest.schema !== "pi-subagent-retention-trash" ||
			!Value.Check(RunIdSchema, manifest.runId) ||
			!Array.isArray(manifest.paths) ||
			manifest.paths.length > 128 ||
			manifest.paths.some(
				(relative) =>
					typeof relative !== "string" || !safeTrashRelative(relative),
			)
		) {
			throw new Error("invalid retention trash manifest");
		}
		let lease: RunLease;
		try {
			lease = await acquireRunLease({
				root: path.join(root, "leases"),
				runId: manifest.runId,
			});
		} catch (error) {
			if (error instanceof RunLeaseUnavailableError) continue;
			throw error;
		}
		try {
			const leaseRelative = path.join("leases", `${manifest.runId}.lease.json`);
			const orderedPaths = [
				...manifest.paths.filter(
					(relative) =>
						relative !== leaseRelative && relative !== manifest.commitPath,
				),
				...manifest.paths.filter((relative) => relative === leaseRelative),
				...manifest.paths.filter(
					(relative) => relative === manifest.commitPath,
				),
			];
			for (const relative of orderedPaths) {
				const source = path.join(root, relative);
				const destination = path.join(trashPath, relative);
				const sourceExists = await pathExists(source);
				const destinationExists = await pathExists(destination);
				if (sourceExists && destinationExists) {
					throw new Error("retention trash recovery found duplicate state");
				}
				if (!sourceExists && !destinationExists) {
					throw new Error("retention trash recovery found missing state");
				}
				if (!sourceExists) continue;
				if (relative !== manifest.commitPath) {
					await lease.assertCurrent();
				}
				await mkdir(path.dirname(destination), {
					recursive: true,
					mode: 0o700,
				});
				await rename(source, destination);
				await syncDirectory(path.dirname(source));
				await syncDirectory(path.dirname(destination));
			}
			await writeDurable(
				path.join(trashPath, "completed.json"),
				`${JSON.stringify({ runId: manifest.runId, completedAt: new Date().toISOString() }, null, 2)}\n`,
			);
			await syncDirectory(trashPath);
			recovered.push(manifest.runId);
		} finally {
			await lease.release();
		}
	}
	return recovered;
}

async function moveRunToTrash(options: {
	root: string;
	trashRoot: string;
	run: RetentionRun;
	paths: string[];
	now: Date;
}): Promise<string> {
	const trashPath = path.join(
		options.trashRoot,
		`${options.now.toISOString().replaceAll(":", "-")}-${options.run.runId}-${randomUUID()}`,
	);
	await mkdir(trashPath, { recursive: true, mode: 0o700 });
	const runRecordPath = path.join(
		options.root,
		"run-records",
		`${options.run.runId}.json`,
	);
	const orderedPaths = [
		...options.paths.filter((candidate) => candidate !== runRecordPath),
		...options.paths.filter((candidate) => candidate === runRecordPath),
	];
	const manifest = {
		schema: "pi-subagent-retention-trash",
		contractRevision: CONTRACT_REVISION,
		runId: options.run.runId,
		createdAt: options.now.toISOString(),
		commitPath: relativeWithin(options.root, runRecordPath),
		paths: orderedPaths.map((candidate) =>
			relativeWithin(options.root, candidate),
		),
	};
	await writeDurable(
		path.join(trashPath, "manifest.json"),
		`${JSON.stringify(manifest, null, 2)}\n`,
	);
	await syncDirectory(trashPath);
	for (const source of orderedPaths) {
		if (!(await pathExists(source))) continue;
		const destination = path.join(
			trashPath,
			relativeWithin(options.root, source),
		);
		await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
		await rename(source, destination);
		await syncDirectory(path.dirname(source));
		await syncDirectory(path.dirname(destination));
	}
	await writeDurable(
		path.join(trashPath, "completed.json"),
		`${JSON.stringify({ runId: options.run.runId, completedAt: new Date().toISOString() }, null, 2)}\n`,
	);
	await syncDirectory(trashPath);
	return trashPath;
}

export async function createRetentionManager(options: {
	root: string;
	trashRoot?: string;
}): Promise<RetentionManager> {
	await mkdir(options.root, { recursive: true, mode: 0o700 });
	const root = await realpath(options.root);
	const retentionRoot = path.join(root, "retention");
	const pinsRoot = path.join(retentionRoot, "pins");
	await mkdir(pinsRoot, { recursive: true, mode: 0o700 });
	await chmod(pinsRoot, 0o700);
	const requestedTrashRoot =
		options.trashRoot ?? path.join(path.dirname(root), "trash");
	await mkdir(requestedTrashRoot, { recursive: true, mode: 0o700 });
	const trashRoot = await realpath(requestedTrashRoot);
	if (isInside(root, trashRoot) || isInside(trashRoot, root)) {
		throw new Error("retention trash must be a disjoint sibling path");
	}

	const withLease = async <T>(operation: () => Promise<T>): Promise<T> => {
		const release = await bindRetentionLease(retentionRoot);
		try {
			return await operation();
		} finally {
			await release();
		}
	};

	const listPinsUnlocked = async (runId?: RunId): Promise<RetentionPin[]> => {
		const pins: RetentionPin[] = [];
		for (const entry of (await readdir(pinsRoot)).sort()) {
			if (!entry.endsWith(".json")) continue;
			const pin = await readPin(path.join(pinsRoot, entry));
			if (!runId || pin.runId === runId) pins.push(pin);
		}
		return pins;
	};

	return {
		root,
		trashRoot,
		listPins(runId) {
			return withLease(() => listPinsUnlocked(runId));
		},
		async pin(ownerId, runId, reason) {
			if (!ownerId.trim() || Buffer.byteLength(ownerId) > 256) {
				throw new Error("invalid retention pin owner");
			}
			if (!Value.Check(RunIdSchema, runId)) throw new Error("invalid run ID");
			if (!reason.trim() || Buffer.byteLength(reason) > 512) {
				throw new Error("invalid retention pin reason");
			}
			return withLease(async () => {
				if (
					!(await pathExists(path.join(root, "run-records", `${runId}.json`)))
				) {
					throw new Error("cannot pin a missing run");
				}
				const pin: RetentionPin = {
					schema: "pi-subagent-retention-pin",
					contractRevision: CONTRACT_REVISION,
					runId,
					ownerId,
					reason,
					createdAt: new Date().toISOString(),
				};
				const target = path.join(pinsRoot, `${pinKey(ownerId, runId)}.json`);
				const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
				const content = `${JSON.stringify(pin, null, 2)}\n`;
				if (Buffer.byteLength(content) > MAX_PIN_BYTES) {
					throw new Error("retention pin exceeds size limit");
				}
				await writeDurable(temporary, content);
				try {
					await link(temporary, target);
					await syncDirectory(pinsRoot);
					return pin;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
					const existing = await readPin(target);
					if (
						existing.ownerId !== ownerId ||
						existing.runId !== runId ||
						existing.reason !== reason
					) {
						throw new Error("retention pin conflicts with existing identity");
					}
					return existing;
				} finally {
					await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
						if (error.code !== "ENOENT") throw error;
					});
				}
			});
		},
		async unpin(ownerId, runId) {
			return withLease(async () => {
				const source = path.join(pinsRoot, `${pinKey(ownerId, runId)}.json`);
				if (!(await pathExists(source))) return false;
				const existing = await readPin(source);
				if (existing.ownerId !== ownerId || existing.runId !== runId) {
					throw new Error("retention pin identity mismatch");
				}
				const destination = path.join(
					trashRoot,
					"pins",
					`${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}-${path.basename(source)}`,
				);
				await mkdir(path.dirname(destination), {
					recursive: true,
					mode: 0o700,
				});
				await rename(source, destination);
				await syncDirectory(pinsRoot);
				await syncDirectory(path.dirname(destination));
				return true;
			});
		},
		async prune(pruneOptions) {
			const maxAgeMs = pruneOptions.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
			const maxBytes = pruneOptions.maxBytes ?? DEFAULT_MAX_BYTES;
			if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0) {
				throw new Error("invalid retention max age");
			}
			if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
				throw new Error("invalid retention byte budget");
			}
			return withLease(async () => {
				const recoveredTrashIntents = pruneOptions.dryRun
					? []
					: await recoverTrashIntents(root, trashRoot);
				const recoveredSet = new Set(recoveredTrashIntents);
				const candidateRuns = pruneOptions.runs.filter(
					(run) => !recoveredSet.has(run.runId),
				);
				const seenRunIds = new Set<string>();
				for (const run of candidateRuns) {
					if (
						!Value.Check(RunIdSchema, run.runId) ||
						!Value.Check(RunStatusSchema, run.status) ||
						run.attemptIds.some(
							(attemptId) => !Value.Check(AttemptIdSchema, attemptId),
						) ||
						run.attemptIds.length > 32 ||
						run.worktreeAttemptIds.some(
							(attemptId) => !Value.Check(AttemptIdSchema, attemptId),
						) ||
						run.worktreeAttemptIds.length > 32 ||
						new Set(run.attemptIds).size !== run.attemptIds.length ||
						new Set(run.worktreeAttemptIds).size !==
							run.worktreeAttemptIds.length ||
						seenRunIds.has(run.runId)
					) {
						throw new Error("invalid retention run descriptor");
					}
					if (
						!(await pathExists(
							path.join(root, "run-records", `${run.runId}.json`),
						))
					) {
						throw new Error("retention run root is missing");
					}
					seenRunIds.add(run.runId);
				}
				const now = pruneOptions.now ?? new Date();
				if (!Number.isFinite(now.getTime())) {
					throw new Error("invalid retention clock");
				}
				const startedAt = new Date().toISOString();
				const pins = await listPinsUnlocked();
				const pinnedRuns = new Set(pins.map((pin) => pin.runId));
				const operations = await operationPathsByRun(root);
				const assessed: Array<{
					run: RetentionRun;
					paths: string[];
					bytes: number;
					terminalTime?: number;
				}> = [];
				for (const run of candidateRuns) {
					const paths = await linkedPaths(
						root,
						run,
						operations.get(run.runId) ?? [],
					);
					const seen = new Set<string>();
					let bytes = 0;
					for (const candidate of paths) {
						bytes += await treeBytes(candidate, seen);
					}
					const terminalTime = run.terminalAt
						? Date.parse(run.terminalAt)
						: undefined;
					assessed.push({
						run,
						paths,
						bytes,
						...(terminalTime !== undefined && Number.isFinite(terminalTime)
							? { terminalTime }
							: {}),
					});
				}
				const protectedRuns: RetentionRunReport[] = [];
				const ordinary: typeof assessed = [];
				for (const item of assessed) {
					const reasons: string[] = [];
					if (pinnedRuns.has(item.run.runId)) reasons.push("pinned");
					if (item.run.retainedWorktree) reasons.push("retained-worktree");
					if (!ORDINARY_TERMINAL.has(item.run.status)) {
						reasons.push(`status:${item.run.status}`);
					}
					if (item.terminalTime === undefined)
						reasons.push("terminal-time-unknown");
					if (reasons.length > 0) {
						protectedRuns.push({
							runId: item.run.runId,
							status: item.run.status,
							bytes: item.bytes,
							...(item.run.terminalAt
								? { terminalAt: item.run.terminalAt }
								: {}),
							reasons,
						});
					} else {
						ordinary.push(item);
					}
				}
				ordinary.sort(
					(left, right) =>
						(left.terminalTime ?? 0) - (right.terminalTime ?? 0) ||
						left.run.runId.localeCompare(right.run.runId),
				);
				const selected = new Map<RunId, string[]>();
				for (const item of ordinary) {
					if (
						now.getTime() - (item.terminalTime ?? now.getTime()) >=
						maxAgeMs
					) {
						selected.set(item.run.runId, ["age"]);
					}
				}
				let ordinaryBytesAfter = ordinary
					.filter((item) => !selected.has(item.run.runId))
					.reduce((total, item) => total + item.bytes, 0);
				for (const item of ordinary) {
					if (ordinaryBytesAfter <= maxBytes) break;
					if (selected.has(item.run.runId)) continue;
					selected.set(item.run.runId, ["budget"]);
					ordinaryBytesAfter -= item.bytes;
				}
				const selectedReports: RetentionRunReport[] = ordinary
					.filter((item) => selected.has(item.run.runId))
					.map((item) => ({
						runId: item.run.runId,
						status: item.run.status,
						bytes: item.bytes,
						...(item.run.terminalAt ? { terminalAt: item.run.terminalAt } : {}),
						reasons: selected.get(item.run.runId) ?? [],
					}));
				const pruned: RetentionRunReport[] = [];
				if (!pruneOptions.dryRun) {
					for (const report of selectedReports) {
						const item = ordinary.find(
							(candidate) => candidate.run.runId === report.runId,
						);
						if (!item) throw new Error("retention selection disappeared");
						let lease: RunLease;
						try {
							lease = await acquireRunLease({
								root: path.join(root, "leases"),
								runId: item.run.runId,
							});
						} catch (error) {
							if (error instanceof RunLeaseUnavailableError) {
								protectedRuns.push({
									...report,
									reasons: ["run-lease-unavailable"],
								});
								ordinaryBytesAfter += item.bytes;
								continue;
							}
							throw error;
						}
						try {
							await lease.assertCurrent();
							const leasePath = path.join(
								root,
								"leases",
								`${item.run.runId}.lease.json`,
							);
							if (!item.paths.includes(leasePath)) item.paths.push(leasePath);
							const trashPath = await moveRunToTrash({
								root,
								trashRoot,
								run: item.run,
								paths: item.paths,
								now,
							});
							pruned.push({ ...report, trashPath });
						} finally {
							await lease.release();
						}
					}
				}
				return {
					dryRun: pruneOptions.dryRun,
					startedAt,
					completedAt: new Date().toISOString(),
					policy: { maxAgeMs, maxBytes },
					ordinaryBytesBefore: ordinary.reduce(
						(total, item) => total + item.bytes,
						0,
					),
					ordinaryBytesAfter,
					protected: protectedRuns,
					selected: selectedReports,
					pruned,
					recoveredTrashIntents,
				};
			});
		},
	};
}
