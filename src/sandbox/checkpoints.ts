import { createHash, randomUUID } from "node:crypto";
import {
	link,
	lstat,
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	unlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import { canonicalJson } from "../preflight/canonical.js";

/** Version of the warm-checkpoint layout this runtime writes and reads. */
export const WARM_CHECKPOINT_SCHEMA = "pi-subagent-warm-checkpoint/1";
/** Default bound on the checkpoint store, evicted least recently used. */
export const DEFAULT_CHECKPOINT_STORE_BYTES = 20 * 1024 * 1024 * 1024;
/** How long a failed warm-up keeps a key cold before it is tried again. */
export const WARMUP_FAILURE_RETRY_MS = 60 * 60_000;
const MAX_LOCKFILE_BYTES = 64 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const KEY_PATTERN = /^[a-f0-9]{64}$/u;

export type WarmupFailureCode =
	| "boot-failed"
	| "bind-failed"
	| "install-failed"
	| "timeout"
	| "checkpoint-failed"
	| "resume-failed";

/** Everything a warm checkpoint's contents depend on. */
export type WarmCheckpointInputs = {
	schema: typeof WARM_CHECKPOINT_SCHEMA;
	installCommand: "npm ci";
	lockfileSha256: string;
	/** The root `package.json` `workspaces` field, or null. */
	workspaces: unknown;
	/** Workspace-relative dependency directories bound during warm-up. */
	dependencies: string[];
	guestAssetBuildId: string;
	gondolinVersion: string;
	rootfsPolicySha256: string;
	guestCacheHome: string;
};

export function warmCheckpointKey(inputs: WarmCheckpointInputs): string {
	return createHash("sha256").update(canonicalJson(inputs)).digest("hex");
}

export type WarmProject =
	| { kind: "npm"; lockfileSha256: string; workspaces: unknown }
	| {
			kind: "skip";
			reason: "no-lockfile" | "unsupported-lockfile" | "unreadable-lockfile";
	  };

async function regularFile(file: string, maxBytes: number): Promise<boolean> {
	try {
		const info = await lstat(file);
		return info.isFile() && info.size <= maxBytes;
	} catch {
		return false;
	}
}

/**
 * The install a workspace supports: npm with `package-lock.json` only. pnpm
 * and yarn lockfiles are recognised and not supported in this release.
 */
export async function detectWarmProject(
	workspace: string,
): Promise<WarmProject> {
	const lockfile = path.join(workspace, "package-lock.json");
	if (!(await regularFile(lockfile, MAX_LOCKFILE_BYTES))) {
		for (const other of [
			"pnpm-lock.yaml",
			"yarn.lock",
			"bun.lockb",
			"bun.lock",
		]) {
			if (await regularFile(path.join(workspace, other), MAX_LOCKFILE_BYTES)) {
				return { kind: "skip", reason: "unsupported-lockfile" };
			}
		}
		return { kind: "skip", reason: "no-lockfile" };
	}
	try {
		const lockfileSha256 = createHash("sha256")
			.update(await readFile(lockfile))
			.digest("hex");
		let workspaces: unknown = null;
		const manifest = path.join(workspace, "package.json");
		if (await regularFile(manifest, MAX_MANIFEST_BYTES)) {
			const value: unknown = JSON.parse(await readFile(manifest, "utf8"));
			if (typeof value === "object" && value !== null) {
				workspaces = (value as { workspaces?: unknown }).workspaces ?? null;
			}
		}
		return { kind: "npm", lockfileSha256, workspaces };
	} catch {
		return { kind: "skip", reason: "unreadable-lockfile" };
	}
}

type OwnerFile = { pid: number; createdAt: string };

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function readOwner(file: string): Promise<OwnerFile | undefined> {
	try {
		const value = JSON.parse(
			await readFile(file, "utf8"),
		) as Partial<OwnerFile>;
		return typeof value.pid === "number" ? (value as OwnerFile) : undefined;
	} catch {
		return undefined;
	}
}

async function writeAtomic(file: string, content: string): Promise<void> {
	const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(temporary, content, { mode: 0o600 });
	await rename(temporary, file);
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason);
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason);
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export type CheckpointLease = {
	readonly key: string;
	readonly path: string;
	release(): Promise<void>;
};

export type CheckpointSidecar = {
	schema: typeof WARM_CHECKPOINT_SCHEMA;
	key: string;
	inputs: WarmCheckpointInputs;
	createdAt: string;
	sizeBytes: number;
};

/**
 * Warm checkpoints on the host, one qcow2 per key under
 * `<agentDir>/subagents/checkpoints`. A checkpoint is published by rename and
 * becomes visible only with its sidecar; a leased checkpoint (a running VM's
 * overlay reads it as its backing file) and a key being warmed are never
 * evicted. Ownership of locks and leases is a process id; one whose process is
 * gone is reclaimed.
 */
export class WarmCheckpointStore {
	readonly root: string;
	readonly maxBytes: number;
	readonly failureRetryMs: number;
	private readonly now: () => number;

	constructor(options: {
		root: string;
		maxBytes?: number;
		failureRetryMs?: number;
		now?: () => number;
	}) {
		this.root = options.root;
		this.maxBytes = options.maxBytes ?? DEFAULT_CHECKPOINT_STORE_BYTES;
		this.failureRetryMs = options.failureRetryMs ?? WARMUP_FAILURE_RETRY_MS;
		this.now = options.now ?? Date.now;
		if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 0) {
			throw new Error("checkpoint store bound must be a non-negative integer");
		}
	}

	private file(key: string, suffix: string): string {
		if (!KEY_PATTERN.test(key)) throw new Error("invalid checkpoint key");
		return path.join(this.root, `${key}${suffix}`);
	}

	checkpointPath(key: string): string {
		return this.file(key, ".qcow2");
	}

	private async ensureRoot(): Promise<void> {
		await mkdir(path.join(this.root, "tmp"), { recursive: true, mode: 0o700 });
		await mkdir(path.join(this.root, "leases"), {
			recursive: true,
			mode: 0o700,
		});
	}

	/** A fresh path in the store's own directory for a checkpoint being written. */
	async temporaryPath(): Promise<string> {
		await this.ensureRoot();
		return path.join(this.root, "tmp", `${randomUUID()}.qcow2`);
	}

	async readSidecar(key: string): Promise<CheckpointSidecar | undefined> {
		try {
			const value = JSON.parse(
				await readFile(this.file(key, ".json"), "utf8"),
			) as CheckpointSidecar;
			return value.schema === WARM_CHECKPOINT_SCHEMA && value.key === key
				? value
				: undefined;
		} catch {
			return undefined;
		}
	}

	/** True while a recorded warm-up failure still keeps this key cold. */
	async failedRecently(key: string): Promise<boolean> {
		try {
			const info = await stat(this.file(key, ".failed.json"));
			return this.now() - info.mtimeMs < this.failureRetryMs;
		} catch {
			return false;
		}
	}

	/** Record a failed warm-up by code only; no install output is kept. */
	async recordFailure(key: string, code: WarmupFailureCode): Promise<void> {
		await this.ensureRoot();
		await writeAtomic(
			this.file(key, ".failed.json"),
			`${JSON.stringify({ schema: WARM_CHECKPOINT_SCHEMA, key, code, failedAt: new Date(this.now()).toISOString() })}\n`,
		);
	}

	/**
	 * Take the one warm-up of a key. Returns the release, or undefined while
	 * another live process holds it.
	 */
	async tryLock(key: string): Promise<(() => Promise<void>) | undefined> {
		await this.ensureRoot();
		const lockPath = this.file(key, ".lock");
		for (let round = 0; round < 2; round++) {
			const temporary = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
			await writeFile(
				temporary,
				`${JSON.stringify({ pid: process.pid, createdAt: new Date(this.now()).toISOString() })}\n`,
				{ mode: 0o600 },
			);
			try {
				await link(temporary, lockPath);
				let released = false;
				return async () => {
					if (released) return;
					released = true;
					await unlink(lockPath).catch(() => {});
				};
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			} finally {
				await unlink(temporary).catch(() => {});
			}
			const owner = await readOwner(lockPath);
			if (owner && processAlive(owner.pid)) return undefined;
			await unlink(lockPath).catch(() => {});
		}
		return undefined;
	}

	private async locked(key: string): Promise<boolean> {
		const owner = await readOwner(this.file(key, ".lock"));
		return owner !== undefined && processAlive(owner.pid);
	}

	/**
	 * Lease a published checkpoint so it is not evicted while a VM runs on it.
	 * Undefined when no complete checkpoint exists for the key.
	 */
	async lease(key: string): Promise<CheckpointLease | undefined> {
		await this.ensureRoot();
		const checkpointPath = this.checkpointPath(key);
		const leaseDir = path.join(this.root, "leases", key);
		await mkdir(leaseDir, { recursive: true, mode: 0o700 });
		const leasePath = path.join(leaseDir, `${randomUUID()}.json`);
		await writeAtomic(
			leasePath,
			`${JSON.stringify({ pid: process.pid, createdAt: new Date(this.now()).toISOString() })}\n`,
		);
		const release = async () => {
			await unlink(leasePath).catch(() => {});
		};
		const sidecar = await this.readSidecar(key);
		try {
			if (!sidecar || !(await stat(checkpointPath)).isFile()) {
				await release();
				return undefined;
			}
		} catch {
			await release();
			return undefined;
		}
		const touched = new Date(this.now());
		await utimes(this.file(key, ".json"), touched, touched).catch(() => {});
		let released = false;
		return {
			key,
			path: checkpointPath,
			async release() {
				if (released) return;
				released = true;
				await release();
			},
		};
	}

	private async leased(key: string): Promise<boolean> {
		const leaseDir = path.join(this.root, "leases", key);
		let entries: string[];
		try {
			entries = await readdir(leaseDir);
		} catch {
			return false;
		}
		let live = false;
		for (const entry of entries) {
			const leasePath = path.join(leaseDir, entry);
			const owner = await readOwner(leasePath);
			if (owner && processAlive(owner.pid)) live = true;
			else if (entry.endsWith(".json")) await unlink(leasePath).catch(() => {});
		}
		return live;
	}

	/** Publish a written checkpoint under its key and clear any failure record. */
	async publish(
		key: string,
		temporaryPath: string,
		inputs: WarmCheckpointInputs,
	): Promise<void> {
		const checkpointPath = this.checkpointPath(key);
		await rename(temporaryPath, checkpointPath);
		const sidecar: CheckpointSidecar = {
			schema: WARM_CHECKPOINT_SCHEMA,
			key,
			inputs,
			createdAt: new Date(this.now()).toISOString(),
			sizeBytes: (await stat(checkpointPath)).size,
		};
		await writeAtomic(
			this.file(key, ".json"),
			`${JSON.stringify(sidecar, null, 2)}\n`,
		);
		await unlink(this.file(key, ".failed.json")).catch(() => {});
	}

	/**
	 * Wait for another process's warm-up of `key`: until its checkpoint is
	 * published, its warm-up fails or stops, or `timeoutMs` passes.
	 */
	async waitFor(
		key: string,
		options: { timeoutMs: number; signal?: AbortSignal },
	): Promise<"ready" | "failed" | "abandoned" | "timeout"> {
		const startedAt = performance.now();
		let pollMs = 500;
		for (;;) {
			options.signal?.throwIfAborted();
			if (await this.readSidecar(key)) return "ready";
			if (await this.failedRecently(key)) return "failed";
			if (!(await this.locked(key))) {
				return (await this.readSidecar(key)) ? "ready" : "abandoned";
			}
			const remaining = options.timeoutMs - (performance.now() - startedAt);
			if (remaining <= 0) return "timeout";
			await sleep(Math.min(pollMs, remaining), options.signal);
			pollMs = Math.min(2_000, pollMs * 2);
		}
	}

	/**
	 * Evict least recently used checkpoints until the store fits its bound.
	 * Leased and locked keys stay. Orphaned temporary files of warm-ups that
	 * died are removed once they are a day old.
	 */
	async evict(): Promise<{ evicted: number; evictedBytes: number }> {
		await this.ensureRoot();
		const day = 24 * 60 * 60_000;
		for (const entry of await readdir(path.join(this.root, "tmp"))) {
			const file = path.join(this.root, "tmp", entry);
			try {
				if (this.now() - (await stat(file)).mtimeMs > day)
					await rm(file, { force: true });
			} catch {}
		}
		const candidates: Array<{ key: string; bytes: number; usedAt: number }> =
			[];
		let total = 0;
		for (const entry of await readdir(this.root)) {
			const match = /^([a-f0-9]{64})\.qcow2$/u.exec(entry);
			if (!match) continue;
			const key = match[1] as string;
			let bytes: number;
			try {
				bytes = (await stat(path.join(this.root, entry))).size;
			} catch {
				continue;
			}
			total += bytes;
			let usedAt = 0;
			try {
				usedAt = (await stat(this.file(key, ".json"))).mtimeMs;
			} catch {}
			candidates.push({ key, bytes, usedAt });
		}
		candidates.sort((left, right) => left.usedAt - right.usedAt);
		let evicted = 0;
		let evictedBytes = 0;
		for (const candidate of candidates) {
			if (total <= this.maxBytes) break;
			if (
				(await this.leased(candidate.key)) ||
				(await this.locked(candidate.key))
			) {
				continue;
			}
			// The sidecar goes first, so no new lease can see a half-removed key.
			await unlink(this.file(candidate.key, ".json")).catch(() => {});
			if (await this.leased(candidate.key)) continue;
			await unlink(this.checkpointPath(candidate.key)).catch(() => {});
			total -= candidate.bytes;
			evicted += 1;
			evictedBytes += candidate.bytes;
		}
		return { evicted, evictedBytes };
	}
}
