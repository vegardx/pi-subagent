import { lstat, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import {
	createHttpHooks,
	MemoryProvider,
	ReadonlyProvider,
	RealFSProvider,
	type VirtualProvider,
	VM,
} from "@earendil-works/gondolin";
import {
	captureQemuProcessIdentity,
	type ProcessIdentity,
} from "../reconciliation/process.js";
import type {
	VmCapacityAcquireOptions,
	VmCapacityLease,
	VmCapacityManager,
} from "./capacity.js";
import { createGondolinTools } from "./tools.js";
import { type WriteBudget, withWriteBudget } from "./write-budget.js";

/**
 * The installed Gondolin version, read from its package manifest so the
 * sandbox grant and record name the backend that actually runs.
 */
export const GONDOLIN_VERSION: string = (
	createRequire(import.meta.url)("@earendil-works/gondolin/package.json") as {
		version: string;
	}
).version;
/**
 * The guest image every attempt boots, pinned by its immutable versioned ref.
 * `alpine-base:0.4.0` is the image released with Gondolin 0.14.0; the tmpfs
 * option and VFS chmod forwarding need an image of that line.
 */
export const GUEST_IMAGE_SELECTOR = "alpine-base:0.4.0";
const DEFAULT_CPUS = 1;
/**
 * Virtual size of each attempt's root disk. The root disk is a per-VM qcow2
 * overlay on the host's temporary directory that grows on demand and is
 * deleted when the VM closes, so this bounds the host disk one attempt can
 * consume (about 4 GiB plus qcow2 metadata), not what it reserves. The image
 * itself uses under 200 MiB of it.
 */
export const GUEST_ROOTFS_BYTES = 4 * 1024 * 1024 * 1024;
/**
 * How each attempt's guest storage is laid out: a copy-on-write root disk of
 * `GUEST_ROOTFS_BYTES`, with no scratch tmpfs, so `/tmp`, `/var/tmp`,
 * `/var/cache`, `/var/log`, and `/root` live on that disk instead of in guest
 * memory. Its digest is the launch grant's `rootfsPolicySha256`.
 */
export const GUEST_ROOTFS_POLICY = Object.freeze({
	mode: "cow",
	sizeBytes: GUEST_ROOTFS_BYTES,
	tmpfs: "root-disk",
} as const);
const DEFAULT_START_TIMEOUT_MS = 60_000;
/**
 * The code Gondolin sets on the error `vm.start()` rejects with when the guest
 * does not reach readiness within `startTimeoutMs`. It is a runtime property,
 * not part of Gondolin's declared types, so a test pins it against the
 * installed package.
 */
export const GONDOLIN_START_TIMEOUT_CODE = "vm_start_timeout";

/**
 * Convert a resolved per-run memory ceiling into a Gondolin memory size. The
 * value is a launch-plan grant, so there is no host-side default.
 */
export function guestMemorySize(memoryBytes: number): string {
	if (
		!Number.isSafeInteger(memoryBytes) ||
		memoryBytes <= 0 ||
		memoryBytes % (1024 * 1024) !== 0
	) {
		throw new GondolinSandboxError(
			"sandbox memory must be a positive whole number of MiB",
		);
	}
	return `${memoryBytes / (1024 * 1024)}M`;
}

export type GondolinSandboxRecord = {
	backend: "gondolin";
	packageVersion: string;
	vmId: string;
	hostPid: number;
	hostProcessIdentity: ProcessIdentity;
	capacityLeaseId: string;
	capacitySlot: number;
	workspace: string;
	readOnly: boolean;
	memory: string;
	cpus: number;
	rootfs: typeof GUEST_ROOTFS_POLICY;
	startedAt: string;
};

export type GondolinAttemptSandbox = {
	record: GondolinSandboxRecord;
	vm: VM;
	tools: Awaited<ReturnType<typeof createGondolinTools>>;
	writeBudget: WriteBudget | undefined;
	isClosed(): boolean;
	close(): Promise<void>;
	cancel(): Promise<void>;
};

export class GondolinSandboxError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "GondolinSandboxError";
	}
}

async function closeStartedVm(
	vm: VM,
	capacity: VmCapacityLease,
): Promise<void> {
	await vm.close();
	if (vm.getHostPid() !== null) {
		throw new GondolinSandboxError(
			`VM ${vm.id} retained a host PID after close`,
		);
	}
	await capacity.release();
}

function isGuestReadinessTimeout(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error as { code?: unknown }).code === GONDOLIN_START_TIMEOUT_CODE
	);
}

/**
 * The failure message for a VM that did not start. It is built from the
 * launch's own bounds, never from the underlying exception, whose text is not
 * persisted.
 */
export function sandboxStartFailureMessage(
	error: unknown,
	bounds: { startTimeoutMs: number; memory: string },
): string {
	if (!isGuestReadinessTimeout(error)) return "sandbox startup failed";
	return `sandbox startup failed: guest did not become ready within ${
		bounds.startTimeoutMs / 1000
	} s at ${bounds.memory}`;
}

export async function createGondolinAttemptSandbox(options: {
	owner: string;
	workspace: string;
	readOnly: boolean;
	workspaceWriteBytes: number;
	capacity: VmCapacityManager;
	/** Bounds and cancels the wait for a free VM slot. */
	capacityWait?: VmCapacityAcquireOptions;
	memoryBytes: number;
	cpus?: number;
	startTimeoutMs?: number;
	workspaceAliases?: string[];
	skillMounts?: Array<{ hostBaseDir: string; guestBaseDir: string }>;
	contextMounts?: Array<{ guestFilePath: string; content: string }>;
	onFatalToolAbort?: () => void;
}): Promise<GondolinAttemptSandbox> {
	let workspace: string;
	try {
		workspace = await realpath(options.workspace);
		if (!(await lstat(workspace)).isDirectory()) {
			throw new GondolinSandboxError("sandbox workspace is not a directory");
		}
	} catch (error) {
		if (error instanceof GondolinSandboxError) throw error;
		throw new GondolinSandboxError("sandbox workspace is unavailable", {
			cause: error,
		});
	}
	const realProvider = new RealFSProvider(workspace);
	let writeBudget: WriteBudget | undefined;
	let workspaceProvider: VirtualProvider;
	if (options.readOnly) {
		workspaceProvider = new ReadonlyProvider(realProvider);
	} else {
		const budgeted = withWriteBudget(realProvider, options.workspaceWriteBytes);
		workspaceProvider = budgeted.provider;
		writeBudget = budgeted.budget;
	}
	const mounts: Record<string, VirtualProvider> = {
		"/workspace": workspaceProvider,
	};
	for (const skill of options.skillMounts ?? []) {
		if (mounts[skill.guestBaseDir]) {
			throw new GondolinSandboxError(
				`duplicate guest skill mount: ${skill.guestBaseDir}`,
			);
		}
		const hostBaseDir = await realpath(skill.hostBaseDir);
		if (!(await lstat(hostBaseDir)).isDirectory()) {
			throw new GondolinSandboxError(
				`skill mount is not a directory: ${skill.hostBaseDir}`,
			);
		}
		mounts[skill.guestBaseDir] = new ReadonlyProvider(
			new RealFSProvider(hostBaseDir),
		);
	}
	for (const context of options.contextMounts ?? []) {
		const guestDir = path.posix.dirname(context.guestFilePath);
		const guestName = path.posix.basename(context.guestFilePath);
		if (!guestDir.startsWith("/context/") || guestName === ".") {
			throw new GondolinSandboxError("invalid guest context mount path");
		}
		if (mounts[guestDir]) {
			throw new GondolinSandboxError(
				`duplicate guest context mount: ${guestDir}`,
			);
		}
		const provider = new MemoryProvider();
		if (!provider.writeFile) {
			throw new GondolinSandboxError("context provider cannot write files");
		}
		await provider.writeFile(`/${guestName}`, context.content);
		mounts[guestDir] = new ReadonlyProvider(provider);
	}
	const { httpHooks } = createHttpHooks({ blockInternalRanges: true });
	const memory = guestMemorySize(options.memoryBytes);
	const cpus = options.cpus ?? DEFAULT_CPUS;
	const startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
	const capacityLease = await options.capacity.acquire(
		options.owner,
		options.capacityWait,
	);
	let vm: VM;
	try {
		vm = await VM.create({
			sandbox: { vmm: "qemu", imagePath: GUEST_IMAGE_SELECTOR },
			memory,
			cpus,
			rootfs: {
				mode: GUEST_ROOTFS_POLICY.mode,
				size: GUEST_ROOTFS_POLICY.sizeBytes,
			},
			// An empty set keeps every scratch path on the root disk.
			tmpfs: {},
			startTimeoutMs,
			allowWebSockets: false,
			maxHttpBodyBytes: 8 * 1024 * 1024,
			maxHttpResponseBodyBytes: 32 * 1024 * 1024,
			httpHooks,
			dns: { mode: "synthetic" },
			sessionLabel: `pi-subagent ${options.owner}`,
			vfs: { mounts },
		});
	} catch (error) {
		await capacityLease.release();
		throw new GondolinSandboxError("sandbox construction failed", {
			cause: error,
		});
	}
	try {
		await vm.start();
		const hostPid = vm.getHostPid();
		if (hostPid === null) {
			throw new GondolinSandboxError("started VM has no host PID");
		}
		const hostProcessIdentity = await captureQemuProcessIdentity(hostPid);
		let closed = false;
		let closePromise: Promise<void> | undefined;
		const close = () => {
			if (closed) return Promise.resolve();
			closePromise ??= closeStartedVm(vm, capacityLease)
				.then(() => {
					closed = true;
				})
				.catch((error) => {
					closePromise = undefined;
					throw error;
				});
			return closePromise;
		};
		const tools = await createGondolinTools(
			vm,
			{
				hostWorkspace: workspace,
				hostAliases: options.workspaceAliases ?? [],
			},
			{
				onCommandAbort: async () => {
					try {
						await close();
					} finally {
						options.onFatalToolAbort?.();
					}
				},
				...(writeBudget ? { writeBudget } : {}),
			},
		);
		const record: GondolinSandboxRecord = {
			backend: "gondolin",
			packageVersion: GONDOLIN_VERSION,
			vmId: vm.id,
			hostPid,
			hostProcessIdentity,
			capacityLeaseId: capacityLease.record.leaseId,
			capacitySlot: capacityLease.record.slot,
			workspace,
			readOnly: options.readOnly,
			memory,
			cpus,
			rootfs: GUEST_ROOTFS_POLICY,
			startedAt: new Date().toISOString(),
		};
		return {
			record,
			vm,
			tools,
			writeBudget,
			isClosed: () => closed,
			close,
			cancel: close,
		};
	} catch (error) {
		try {
			await closeStartedVm(vm, capacityLease);
		} catch (cleanupError) {
			throw new GondolinSandboxError(
				"sandbox startup failed and cleanup was not proved",
				{ cause: new AggregateError([error, cleanupError]) },
			);
		}
		throw new GondolinSandboxError(
			sandboxStartFailureMessage(error, { startTimeoutMs, memory }),
			{ cause: error },
		);
	}
}
