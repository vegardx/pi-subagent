import { createHash, randomUUID } from "node:crypto";
import {
	link,
	mkdir,
	readFile,
	realpath,
	rename,
	unlink,
	writeFile,
} from "node:fs/promises";
import net from "node:net";
import path from "node:path";

const MIN_DERIVED_PORT = 42_000;
const DERIVED_PORT_SPAN = 20_000;
export const MAX_SLOTS = 32;
export const DEFAULT_MAX_SLOTS = 16;
/**
 * How long `acquire` waits for a slot before refusing. Slots are short leases
 * held for one attempt's VM, so a full host is normally a queue, not a fault.
 */
export const DEFAULT_CAPACITY_WAIT_MS = 10 * 60_000;
const INITIAL_POLL_MS = 250;
const MAX_POLL_MS = 2_000;

type VmCapacityPolicy = {
	schema: "pi-subagent-vm-capacity-policy";
	maxSlots: number;
	basePort: number;
};

export type VmCapacityLeaseRecord = {
	schema: "pi-subagent-vm-capacity";
	leaseId: string;
	owner: string;
	pid: number;
	processStartedAt: number;
	slot: number;
	port: number;
	acquiredAt: string;
	releaseRequestedAt?: string;
};

export type VmCapacityLease = {
	record: VmCapacityLeaseRecord;
	release(): Promise<void>;
};

export type VmCapacityAcquireOptions = {
	/** Stops waiting; `acquire` rejects with the signal's reason. */
	signal?: AbortSignal;
	/** Overrides the manager's `capacityWaitMs` for this call. */
	waitMs?: number;
};

export type VmCapacityManager = {
	root: string;
	maxSlots: number;
	basePort: number;
	capacityWaitMs: number;
	acquire(
		owner: string,
		options?: VmCapacityAcquireOptions,
	): Promise<VmCapacityLease>;
};

/** Every slot stayed busy for the whole wait bound. */
export class VmCapacityExhaustedError extends Error {
	readonly maxSlots: number;
	readonly waitedMs: number;

	constructor(maxSlots: number, waitedMs: number) {
		super(vmCapacityExhaustedMessage(maxSlots, waitedMs));
		this.name = "VmCapacityExhaustedError";
		this.maxSlots = maxSlots;
		this.waitedMs = waitedMs;
	}
}

export function vmCapacityExhaustedMessage(
	maxSlots: number,
	waitedMs: number,
): string {
	const seconds = Math.round(waitedMs / 1000);
	return `VM capacity exhausted: ${maxSlots} slots busy for ${seconds} s`;
}

function validateMaxSlots(maxSlots: number): void {
	if (!Number.isSafeInteger(maxSlots) || maxSlots < 1 || maxSlots > MAX_SLOTS) {
		throw new Error(`maxSlots must be an integer from 1 to ${MAX_SLOTS}`);
	}
}

function validateWaitMs(waitMs: number): void {
	if (!Number.isSafeInteger(waitMs) || waitMs < 0) {
		throw new Error("capacity wait must be a non-negative safe integer");
	}
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

function validateOwner(owner: string): void {
	if (!owner.trim() || Buffer.byteLength(owner, "utf8") > 256) {
		throw new Error("capacity owner must contain 1-256 UTF-8 bytes");
	}
}

function deriveBasePort(root: string): number {
	const digest = createHash("sha256").update(root).digest();
	const range = DERIVED_PORT_SPAN - MAX_SLOTS + 1;
	return MIN_DERIVED_PORT + (digest.readUInt32BE(0) % range);
}

function validateBasePort(basePort: number, maxSlots: number): void {
	if (
		!Number.isSafeInteger(basePort) ||
		basePort < 1024 ||
		basePort + maxSlots - 1 > 65_535
	) {
		throw new Error(
			"basePort does not provide a valid unprivileged slot range",
		);
	}
}

async function listen(port: number): Promise<net.Server | undefined> {
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
			server.listen({ host: "127.0.0.1", port, exclusive: true });
		});
		server.unref();
		return server;
	} catch (error) {
		server.close();
		if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
			return undefined;
		}
		throw error;
	}
}

async function close(server: net.Server): Promise<void> {
	if (!server.listening) return;
	await new Promise<void>((resolve, reject) => {
		server.close((error) => {
			if (error) reject(error);
			else resolve();
		});
	});
}

async function ensurePolicy(
	root: string,
	policy: VmCapacityPolicy,
): Promise<void> {
	const policyPath = path.join(root, "policy.json");
	const temporary = `${policyPath}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(policy, null, 2)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
	try {
		await link(temporary, policyPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	} finally {
		await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
		});
	}

	const current = JSON.parse(
		await readFile(policyPath, "utf8"),
	) as Partial<VmCapacityPolicy>;
	if (
		current.schema !== policy.schema ||
		current.maxSlots !== policy.maxSlots ||
		current.basePort !== policy.basePort
	) {
		// Every seat sharing this root must count the same slots; a seat never
		// rewrites the recorded policy, because another seat may be using it.
		throw new Error(
			`VM capacity policy mismatch: this seat uses maxSlots=${policy.maxSlots} basePort=${policy.basePort}, but ${policyPath} records maxSlots=${String(current.maxSlots)} basePort=${String(current.basePort)}. Set "maxSlots" in subagents/settings.json to the recorded value, or remove ${policyPath} while no pi-subagent seat is running.`,
		);
	}
}

async function writeRecord(filePath: string, record: VmCapacityLeaseRecord) {
	const temporary = `${filePath}.${process.pid}.${record.leaseId}.tmp`;
	await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
	await rename(temporary, filePath);
}

/**
 * Host VM capacity is counted in slots, not bytes. Host memory exposure is
 * `maxSlots x` the per-run `sandbox.memoryBytes` grant, so the worst case for
 * the default sixteen slots is sixteen times the 4 GiB per-agent ceiling. There
 * is no cross-process total-memory budget: slots are held by OS-owned localhost
 * listeners, and a byte budget would need durable, fenced per-slot accounting
 * that the listener scheme deliberately does not provide.
 *
 * When every slot is busy, `acquire` polls with backoff until a slot frees or
 * `capacityWaitMs` passes, then throws `VmCapacityExhaustedError`.
 */
export async function createVmCapacityManager(options: {
	root: string;
	maxSlots: number;
	basePort?: number;
	capacityWaitMs?: number;
}): Promise<VmCapacityManager> {
	validateMaxSlots(options.maxSlots);
	const capacityWaitMs = options.capacityWaitMs ?? DEFAULT_CAPACITY_WAIT_MS;
	validateWaitMs(capacityWaitMs);
	await mkdir(options.root, { recursive: true, mode: 0o700 });
	const root = await realpath(options.root);
	const basePort = options.basePort ?? deriveBasePort(root);
	validateBasePort(basePort, options.maxSlots);
	await ensurePolicy(root, {
		schema: "pi-subagent-vm-capacity-policy",
		maxSlots: options.maxSlots,
		basePort,
	});

	return {
		root,
		maxSlots: options.maxSlots,
		basePort,
		capacityWaitMs,
		async acquire(owner, acquireOptions = {}) {
			validateOwner(owner);
			const waitMs = acquireOptions.waitMs ?? capacityWaitMs;
			validateWaitMs(waitMs);
			const signal = acquireOptions.signal;
			const startedAt = performance.now();
			let pollMs = INITIAL_POLL_MS;
			for (;;) {
				signal?.throwIfAborted();
				const lease = await tryAcquire(owner);
				if (lease) return lease;
				const waitedMs = performance.now() - startedAt;
				const remainingMs = waitMs - waitedMs;
				if (remainingMs <= 0) {
					throw new VmCapacityExhaustedError(
						options.maxSlots,
						Math.round(waitedMs),
					);
				}
				await sleep(Math.min(pollMs, remainingMs), signal);
				pollMs = Math.min(MAX_POLL_MS, pollMs * 2);
			}
		},
	};

	async function tryAcquire(
		owner: string,
	): Promise<VmCapacityLease | undefined> {
		for (let slot = 0; slot < options.maxSlots; slot++) {
			const port = basePort + slot;
			const server = await listen(port);
			if (!server) continue;

			const record: VmCapacityLeaseRecord = {
				schema: "pi-subagent-vm-capacity",
				leaseId: randomUUID(),
				owner,
				pid: process.pid,
				processStartedAt: performance.timeOrigin,
				slot,
				port,
				acquiredAt: new Date().toISOString(),
			};
			const recordPath = path.join(root, `slot-${slot}.json`);
			try {
				await writeRecord(recordPath, record);
			} catch (error) {
				await close(server);
				throw error;
			}

			let releasePromise: Promise<void> | undefined;
			return {
				record,
				release() {
					releasePromise ??= (async () => {
						let recordError: unknown;
						try {
							await writeRecord(recordPath, {
								...record,
								releaseRequestedAt: new Date().toISOString(),
							});
						} catch (error) {
							recordError = error;
						}
						await close(server);
						if (recordError) throw recordError;
					})();
					return releasePromise;
				},
			};
		}
		return undefined;
	}
}
