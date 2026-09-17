import { mkdir, open, readdir, readFile, rename, stat } from "node:fs/promises";
import path from "node:path";
import {
	CONTRACT_REVISION,
	IncompatibleContractRevisionError,
} from "../contracts.js";

/**
 * Store-open revision gate.
 *
 * Persisted state is written at one exact contract revision and is never read
 * at another: there is no migration, no adapter, and no dual-format reader
 * here. This gate only reads the `contractRevision` field, never the record
 * around it.
 *
 * State from a NEWER revision is a downgrade and still refuses the start; the
 * running build cannot reason about state it has never written. State from an
 * OLDER revision is discarded rather than read: the entries are moved, whole,
 * into `<store>/quarantine/<revision>/` so the shared service starts clean on
 * an empty history, the operator keeps the bytes, and one notice says what
 * moved and why. A stale record left in place would otherwise make the shared
 * service unstartable for every consumer in the seat.
 */

/** Largest file the gate will parse to find a revision. */
const MAX_PROBE_BYTES = 2 * 1024 * 1024;
/** Largest first journal line the gate will parse (one bounded event). */
const MAX_LINE_BYTES = 128 * 1024;

export type StoreQuarantine = {
	/** Absolute path of `<store>/quarantine`. */
	readonly root: string;
	/** Stale revisions found, ascending. */
	readonly revisions: readonly number[];
	/** Store-relative paths that were moved, sorted. */
	readonly entries: readonly string[];
};

type Probe = { readonly relative: string; readonly revision: number };

async function entries(directory: string): Promise<string[]> {
	try {
		return (await readdir(directory)).sort();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

async function exists(target: string): Promise<boolean> {
	try {
		await stat(target);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

function revisionOf(value: unknown): number | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	if (!("contractRevision" in value)) return undefined;
	const revision = (value as { contractRevision: unknown }).contractRevision;
	return typeof revision === "number" && Number.isInteger(revision)
		? revision
		: undefined;
}

/** First line of a JSONL file, bounded; `undefined` when absent or oversized. */
async function firstLine(file: string): Promise<string | undefined> {
	const handle = await open(file, "r");
	try {
		const buffer = Buffer.alloc(MAX_LINE_BYTES);
		const { bytesRead } = await handle.read(buffer, 0, MAX_LINE_BYTES, 0);
		const text = buffer.subarray(0, bytesRead).toString("utf8");
		const end = text.indexOf("\n");
		return end === -1 ? undefined : text.slice(0, end);
	} finally {
		await handle.close();
	}
}

/**
 * The revision a persisted file declares, or `undefined` when the file is
 * missing, oversized, unparseable, or carries no revision. Anything this gate
 * cannot classify is left exactly where it is, for the store's own corruption
 * rules to answer on read.
 */
async function probeRevision(file: string): Promise<number | undefined> {
	try {
		const metadata = await stat(file);
		if (!metadata.isFile()) return undefined;
		if (file.endsWith(".jsonl")) {
			const line = await firstLine(file);
			return line === undefined ? undefined : revisionOf(JSON.parse(line));
		}
		if (metadata.size > MAX_PROBE_BYTES) return undefined;
		return revisionOf(JSON.parse(await readFile(file, "utf8")));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		if (error instanceof SyntaxError) return undefined;
		throw error;
	}
}

async function probe(
	root: string,
	relative: string,
	into: Probe[],
): Promise<void> {
	const revision = await probeRevision(path.join(root, relative));
	if (revision !== undefined) into.push({ relative, revision });
}

/** Every persisted file in the store that declares a contract revision. */
async function probeStore(root: string): Promise<{
	runs: Map<string, number>;
	attempts: Map<string, number>;
	loose: Probe[];
	newest: number;
}> {
	const runs = new Map<string, number>();
	const attempts = new Map<string, number>();
	const loose: Probe[] = [];
	let newest: number = CONTRACT_REVISION;

	const runScoped: Probe[] = [];
	for (const entry of await entries(path.join(root, "run-records"))) {
		if (!entry.endsWith(".json")) continue;
		await probe(root, path.join("run-records", entry), runScoped);
	}
	for (const entry of await entries(path.join(root, "leases"))) {
		if (!entry.endsWith(".lease.json")) continue;
		await probe(root, path.join("leases", entry), runScoped);
	}
	for (const runId of await entries(path.join(root, "runs"))) {
		for (const file of ["events.jsonl", "run.json"]) {
			await probe(root, path.join("runs", runId, file), runScoped);
		}
	}
	for (const runId of await entries(path.join(root, "attempt-records"))) {
		for (const entry of await entries(
			path.join(root, "attempt-records", runId),
		)) {
			if (!entry.endsWith(".json")) continue;
			await probe(root, path.join("attempt-records", runId, entry), runScoped);
		}
	}
	for (const found of runScoped) {
		const [, runId] = found.relative.split(path.sep);
		const id = runId?.endsWith(".lease.json")
			? runId.slice(0, -".lease.json".length)
			: runId?.endsWith(".json")
				? runId.slice(0, -".json".length)
				: runId;
		if (id)
			runs.set(id, Math.min(runs.get(id) ?? found.revision, found.revision));
		newest = Math.max(newest, found.revision);
	}

	const attemptScoped: Probe[] = [];
	for (const entry of await entries(path.join(root, "workspace", "records"))) {
		if (!entry.endsWith(".json")) continue;
		await probe(root, path.join("workspace", "records", entry), attemptScoped);
	}
	for (const found of attemptScoped) {
		const file = path.basename(found.relative);
		attempts.set(file.slice(0, -".json".length), found.revision);
		newest = Math.max(newest, found.revision);
	}

	for (const entry of await entries(path.join(root, "operations"))) {
		if (!entry.endsWith(".json")) continue;
		await probe(root, path.join("operations", entry), loose);
	}
	for (const entry of await entries(path.join(root, "retention", "pins"))) {
		if (!entry.endsWith(".json")) continue;
		await probe(root, path.join("retention", "pins", entry), loose);
	}
	for (const found of loose) newest = Math.max(newest, found.revision);

	return { runs, attempts, loose, newest };
}

/** Attempt identities recorded under a run, from file names alone. */
async function attemptIdsOf(root: string, runId: string): Promise<string[]> {
	const found: string[] = [];
	for (const entry of await entries(
		path.join(root, "attempt-records", runId),
	)) {
		if (entry.endsWith(".json")) found.push(entry.slice(0, -".json".length));
	}
	return found;
}

async function destination(
	quarantineRoot: string,
	revision: number,
	relative: string,
): Promise<string> {
	const target = path.join(quarantineRoot, String(revision), relative);
	if (!(await exists(target))) return target;
	for (let ordinal = 2; ordinal < 1000; ordinal += 1) {
		const candidate = `${target}.${ordinal}`;
		if (!(await exists(candidate))) return candidate;
	}
	throw new Error("quarantine destination is exhausted");
}

/**
 * Move stale state aside so the store opens clean, or refuse a downgrade.
 *
 * Returns `undefined` when every persisted file matches the running contract
 * revision, which is the ordinary case.
 */
export async function quarantineStaleState(
	storeRoot: string,
): Promise<StoreQuarantine | undefined> {
	const { runs, attempts, loose, newest } = await probeStore(storeRoot);
	if (newest > CONTRACT_REVISION) {
		throw new IncompatibleContractRevisionError(newest);
	}

	const moves = new Map<string, number>();
	const add = (relative: string, revision: number) => {
		const current = moves.get(relative);
		if (current === undefined || revision < current) {
			moves.set(relative, revision);
		}
	};
	const staleAttempts = new Map<string, number>(
		[...attempts].filter(([, revision]) => revision < CONTRACT_REVISION),
	);
	for (const [runId, revision] of runs) {
		if (revision >= CONTRACT_REVISION) continue;
		add(path.join("run-records", `${runId}.json`), revision);
		add(path.join("leases", `${runId}.lease.json`), revision);
		add(path.join("runs", runId), revision);
		for (const attemptId of await attemptIdsOf(storeRoot, runId)) {
			staleAttempts.set(attemptId, revision);
		}
		add(path.join("attempt-records", runId), revision);
	}
	// Sessions and worktrees carry no revision of their own; they belong to an
	// attempt, and an attempt whose records are quarantined must not leave its
	// transcript or worktree record behind for a reconciler to adopt.
	for (const [attemptId, revision] of staleAttempts) {
		add(path.join("sessions", attemptId), revision);
		add(path.join("workspace", "records", `${attemptId}.json`), revision);
		add(path.join("workspace", "worktrees", attemptId), revision);
	}
	for (const found of loose) {
		if (found.revision < CONTRACT_REVISION) add(found.relative, found.revision);
	}

	const quarantineRoot = path.join(storeRoot, "quarantine");
	const moved: string[] = [];
	const revisions = new Set<number>();
	for (const relative of [...moves.keys()].sort()) {
		const revision = moves.get(relative) as number;
		const source = path.join(storeRoot, relative);
		if (!(await exists(source))) continue;
		const target = await destination(quarantineRoot, revision, relative);
		await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
		await rename(source, target);
		moved.push(relative);
		revisions.add(revision);
	}
	if (moved.length === 0) return undefined;
	return Object.freeze({
		root: quarantineRoot,
		revisions: Object.freeze([...revisions].sort((a, b) => a - b)),
		entries: Object.freeze(moved),
	});
}

/** The single operator notice for a quarantine, with no host paths in it. */
export function describeQuarantine(quarantine: StoreQuarantine): string {
	const revisions = quarantine.revisions.join(" and ");
	const count = quarantine.entries.length;
	const directory =
		quarantine.revisions.length === 1
			? `quarantine/${quarantine.revisions[0]}`
			: "quarantine";
	return (
		`pi-subagent quarantined ${count} persisted ${count === 1 ? "entry" : "entries"} ` +
		`from contract revision ${revisions} into the subagent store's ${directory} directory: ` +
		`this build writes revision ${CONTRACT_REVISION} and does not read earlier state. ` +
		`Those runs are no longer listed; the service started with the remaining history.`
	);
}
