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
const MAX_SLOTS = 32;

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
	releasedAt?: string;
};

export type VmCapacityLease = {
	record: VmCapacityLeaseRecord;
	release(): Promise<void>;
};

export type VmCapacityManager = {
	root: string;
	maxSlots: number;
	basePort: number;
	acquire(owner: string): Promise<VmCapacityLease>;
};

export class VmCapacityExhaustedError extends Error {
	readonly maxSlots: number;

	constructor(maxSlots: number) {
		super(`VM capacity exhausted (${maxSlots} slots)`);
		this.name = "VmCapacityExhaustedError";
		this.maxSlots = maxSlots;
	}
}

function validateMaxSlots(maxSlots: number): void {
	if (!Number.isSafeInteger(maxSlots) || maxSlots < 1 || maxSlots > MAX_SLOTS) {
		throw new Error(`maxSlots must be an integer from 1 to ${MAX_SLOTS}`);
	}
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
		throw new Error(
			`VM capacity policy mismatch: expected=${JSON.stringify(policy)} actual=${JSON.stringify(current)}`,
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

export async function createVmCapacityManager(options: {
	root: string;
	maxSlots: number;
	basePort?: number;
}): Promise<VmCapacityManager> {
	validateMaxSlots(options.maxSlots);
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
		async acquire(owner) {
			validateOwner(owner);
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
									releasedAt: new Date().toISOString(),
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
			throw new VmCapacityExhaustedError(options.maxSlots);
		},
	};
}
