import { lstat, realpath } from "node:fs/promises";
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
import type { VmCapacityLease, VmCapacityManager } from "./capacity.js";
import { createGondolinTools } from "./tools.js";
import { type WriteBudget, withWriteBudget } from "./write-budget.js";

const GONDOLIN_VERSION = "0.12.0";

export type GondolinSandboxRecord = {
	backend: "gondolin";
	packageVersion: typeof GONDOLIN_VERSION;
	vmId: string;
	hostPid: number;
	hostProcessIdentity: ProcessIdentity;
	capacityLeaseId: string;
	capacitySlot: number;
	workspace: string;
	readOnly: boolean;
	memory: string;
	cpus: number;
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

export async function createGondolinAttemptSandbox(options: {
	owner: string;
	workspace: string;
	readOnly: boolean;
	workspaceWriteBytes: number;
	capacity: VmCapacityManager;
	memory?: string;
	cpus?: number;
	startTimeoutMs?: number;
	workspaceAliases?: string[];
	skillMounts?: Array<{ hostBaseDir: string; guestBaseDir: string }>;
	contextMounts?: Array<{ guestFilePath: string; content: string }>;
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
	const memory = options.memory ?? "512M";
	const cpus = options.cpus ?? 1;
	const capacityLease = await options.capacity.acquire(options.owner);
	let vm: VM;
	try {
		vm = await VM.create({
			sandbox: { vmm: "qemu" },
			memory,
			cpus,
			rootfs: { mode: "memory" },
			startTimeoutMs: options.startTimeoutMs ?? 60_000,
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
		const tools = await createGondolinTools(vm, {
			hostWorkspace: workspace,
			hostAliases: options.workspaceAliases ?? [],
		});
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
			startedAt: new Date().toISOString(),
		};
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
		throw new GondolinSandboxError("sandbox startup failed", { cause: error });
	}
}
