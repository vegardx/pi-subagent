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
	type VMOptions,
	VmCheckpoint,
} from "@earendil-works/gondolin";
import { canonicalSha256 } from "../preflight/canonical.js";
import {
	captureQemuProcessIdentity,
	type ProcessIdentity,
} from "../reconciliation/process.js";
import type {
	VmCapacityAcquireOptions,
	VmCapacityLease,
	VmCapacityManager,
} from "./capacity.js";
import {
	type CheckpointLease,
	detectWarmProject,
	WARM_CHECKPOINT_SCHEMA,
	type WarmCheckpointInputs,
	type WarmCheckpointStore,
	type WarmupFailureCode,
	warmCheckpointKey,
} from "./checkpoints.js";
import {
	type DependencyDirectoryPlan,
	dependencyBindCommands,
	GUEST_DEPENDENCY_ROOT,
	planDependencyDirectories,
} from "./dependencies.js";
import {
	createGondolinTools,
	GUEST_CACHE_HOME,
	GUEST_WORKSPACE,
	sanitizeGuestEnvironment,
} from "./tools.js";
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

/**
 * The mount layout every attempt gets, digested into the launch grant's
 * `mountPolicySha256`: the workspace over Gondolin's VFS, with Git-ignored
 * dependency directories bound onto the root disk.
 */
export const GUEST_MOUNT_POLICY = Object.freeze({
	backend: "gondolin-vfs",
	version: 2,
	workspace: GUEST_WORKSPACE,
	dependencyBinds: {
		root: GUEST_DEPENDENCY_ROOT,
		directories: "node_modules of the root and npm workspaces members",
		requires: "git check-ignore",
	},
} as const);

/** Bound on one warm-up's dependency install. */
export const WARMUP_TIMEOUT_MS = 10 * 60_000;
/** How long an attempt waits for another process's warm-up of its key. */
export const WARMUP_WAIT_MS = 10 * 60_000;

/** Where warm checkpoints come from, supplied by the runtime host. */
export type WarmCheckpointOptions = {
	store: WarmCheckpointStore;
	/** Build id of the pinned guest image; part of every checkpoint key. */
	guestAssetBuildId: string;
	warmupTimeoutMs?: number;
	waitTimeoutMs?: number;
};

export type WarmupOutcome =
	| "reused"
	| "created"
	| "waited"
	| "failed"
	| "failed-recently"
	| "wait-timeout"
	| "abandoned"
	| "build-mismatch"
	| "resume-failed"
	| "disabled"
	| "no-lockfile"
	| "unsupported-lockfile"
	| "unreadable-lockfile"
	| "no-dependency-directory";

/** How an attempt's VM booted. Keys, never paths. */
export type SandboxBootRecord = {
	mode: "warm" | "cold";
	warmup: WarmupOutcome;
	checkpointKey?: string;
	failure?: WarmupFailureCode;
	warmupMs?: number;
};

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
	/** Workspace dependency directories bound onto the root disk. */
	dependencies: DependencyDirectoryPlan;
	boot: SandboxBootRecord;
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
	checkpoint?: CheckpointLease,
): Promise<void> {
	await vm.close();
	if (vm.getHostPid() !== null) {
		throw new GondolinSandboxError(
			`VM ${vm.id} retained a host PID after close`,
		);
	}
	// The overlay read the checkpoint as its backing file until the VM closed.
	await checkpoint?.release();
	await capacity.release();
}

/** A warm-up VM whose close was not proved; its slot must stay held. */
class WarmupCleanupError extends GondolinSandboxError {
	constructor() {
		super("warm-up VM cleanup was not proved");
	}
}

type WarmBoot = {
	outcome: WarmupOutcome;
	key?: string;
	inputs?: WarmCheckpointInputs;
	lease?: CheckpointLease;
	unlock?: () => Promise<void>;
	failure?: WarmupFailureCode;
	warmupMs?: number;
};

/**
 * Find or claim the warm checkpoint for this workspace, before a VM slot is
 * held: reuse a published one, take the warm-up, or wait for another
 * process's warm-up up to its bound. Anything else boots cold.
 */
async function prepareWarmBoot(options: {
	warm: WarmCheckpointOptions | undefined;
	workspace: string;
	dependencies: DependencyDirectoryPlan;
	signal: AbortSignal | undefined;
}): Promise<WarmBoot> {
	if (!options.warm) return { outcome: "disabled" };
	const project = await detectWarmProject(options.workspace);
	if (project.kind === "skip") return { outcome: project.reason };
	if (!options.dependencies.bound.includes("node_modules")) {
		return { outcome: "no-dependency-directory" };
	}
	const inputs: WarmCheckpointInputs = {
		schema: WARM_CHECKPOINT_SCHEMA,
		installCommand: "npm ci",
		lockfileSha256: project.lockfileSha256,
		workspaces: project.workspaces,
		dependencies: options.dependencies.bound,
		guestAssetBuildId: options.warm.guestAssetBuildId,
		gondolinVersion: GONDOLIN_VERSION,
		rootfsPolicySha256: canonicalSha256(GUEST_ROOTFS_POLICY),
		guestCacheHome: GUEST_CACHE_HOME,
	};
	const key = warmCheckpointKey(inputs);
	const store = options.warm.store;
	const lease = await store.lease(key);
	if (lease) return { outcome: "reused", key, lease };
	if (await store.failedRecently(key))
		return { outcome: "failed-recently", key };
	const unlock = await store.tryLock(key);
	if (unlock) return { outcome: "created", key, inputs, unlock };
	const waited = await store.waitFor(key, {
		timeoutMs: options.warm.waitTimeoutMs ?? WARMUP_WAIT_MS,
		...(options.signal ? { signal: options.signal } : {}),
	});
	if (waited === "ready") {
		const ready = await store.lease(key);
		if (ready) return { outcome: "waited", key, lease: ready };
		return { outcome: "abandoned", key };
	}
	return {
		outcome: waited === "timeout" ? "wait-timeout" : waited,
		key,
	};
}

/**
 * The model-free warm-up: boot a VM with the attempt's policies and the
 * workspace read-only, bind its dependency directories, run `npm ci`, and
 * checkpoint the root disk. Returns a failure code, never install output.
 * Cancellation propagates; the VM is always closed, and a VM whose close is
 * not proved fails the start instead of releasing its slot.
 */
async function runWarmup(options: {
	vmOptions: VMOptions;
	dependencies: DependencyDirectoryPlan;
	timeoutMs: number;
	signal: AbortSignal | undefined;
	checkpointPath: string;
}): Promise<WarmupFailureCode | undefined> {
	let vm: VM | undefined;
	let failure: WarmupFailureCode | undefined;
	let cancelled: unknown;
	try {
		vm = await VM.create(options.vmOptions);
		await vm.start();
	} catch {
		failure = "boot-failed";
	}
	if (vm && !failure) {
		try {
			await bindDependencyDirectories(vm, options.dependencies);
		} catch {
			failure = "bind-failed";
		}
	}
	if (vm && !failure) {
		const timeout = AbortSignal.timeout(options.timeoutMs);
		const signal = options.signal
			? AbortSignal.any([options.signal, timeout])
			: timeout;
		try {
			const result = await vm.exec(
				["/bin/sh", "-lc", "npm ci --no-audit --no-fund"],
				{
					cwd: GUEST_WORKSPACE,
					env: sanitizeGuestEnvironment(undefined),
					signal,
					stdout: "ignore",
					stderr: "ignore",
				},
			);
			if (result.exitCode !== 0) failure = "install-failed";
		} catch {
			failure = "install-failed";
		}
		if (options.signal?.aborted) cancelled = options.signal.reason;
		else if (timeout.aborted) failure = "timeout";
	}
	if (vm && !failure && cancelled === undefined) {
		try {
			await vm.checkpoint(options.checkpointPath);
		} catch {
			failure = "checkpoint-failed";
		}
	}
	if (vm) {
		await vm.close().catch(() => {});
		if (vm.getHostPid() !== null) throw new WarmupCleanupError();
	}
	if (cancelled !== undefined) throw cancelled;
	return failure;
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

/**
 * Bind each planned dependency directory onto the guest root disk before any
 * tool runs, so installs never traverse the workspace VFS. A bind that fails
 * fails the start: the record would otherwise claim a layout the guest lacks.
 */
async function bindDependencyDirectories(
	vm: VM,
	plan: DependencyDirectoryPlan,
): Promise<void> {
	for (const command of dependencyBindCommands(plan, GUEST_WORKSPACE)) {
		const result = await vm.exec(command);
		if (result.exitCode !== 0) {
			throw new GondolinSandboxError("dependency directory bind failed");
		}
	}
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
	/**
	 * Whether absent dependency directories may be created on the host side of
	 * the workspace mount. True only for a checkout the host owns: a worktree
	 * or a read-only snapshot, never the operator's live checkout.
	 */
	createDependencyMountpoints?: boolean;
	/** Boot from a warm per-project checkpoint when one exists or can be made. */
	warmCheckpoints?: WarmCheckpointOptions;
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
	let dependencies: DependencyDirectoryPlan;
	try {
		dependencies = await planDependencyDirectories({
			workspace,
			createMountpoints: options.createDependencyMountpoints === true,
		});
	} catch (error) {
		throw new GondolinSandboxError("dependency directory planning failed", {
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
	const memory = guestMemorySize(options.memoryBytes);
	const cpus = options.cpus ?? DEFAULT_CPUS;
	const startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
	const vmOptions = (
		vfsMounts: Record<string, VirtualProvider>,
	): VMOptions => ({
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
		httpHooks: createHttpHooks({ blockInternalRanges: true }).httpHooks,
		dns: { mode: "synthetic" },
		sessionLabel: `pi-subagent ${options.owner}`,
		vfs: { mounts: vfsMounts },
	});
	const signal = options.capacityWait?.signal;
	const warm = await prepareWarmBoot({
		warm: options.warmCheckpoints,
		workspace,
		dependencies,
		signal,
	});
	let capacityLease: VmCapacityLease;
	try {
		capacityLease = await options.capacity.acquire(
			options.owner,
			options.capacityWait,
		);
	} catch (error) {
		await warm.unlock?.();
		await warm.lease?.release();
		throw error;
	}
	if (warm.unlock && warm.key && warm.inputs && options.warmCheckpoints) {
		const store = options.warmCheckpoints.store;
		const startedAt = performance.now();
		try {
			const checkpointPath = await store.temporaryPath();
			const failure = await runWarmup({
				vmOptions: vmOptions({
					[GUEST_WORKSPACE]: new ReadonlyProvider(
						new RealFSProvider(workspace),
					),
				}),
				dependencies,
				timeoutMs: options.warmCheckpoints.warmupTimeoutMs ?? WARMUP_TIMEOUT_MS,
				signal,
				checkpointPath,
			});
			if (failure) {
				await store.recordFailure(warm.key, failure);
				warm.outcome = "failed";
				warm.failure = failure;
			} else {
				await store.publish(warm.key, checkpointPath, warm.inputs);
				await store.evict();
				const lease = await store.lease(warm.key);
				if (lease) warm.lease = lease;
				else warm.outcome = "abandoned";
			}
		} catch (error) {
			if (error instanceof WarmupCleanupError) {
				// The slot stays held: a VM that may still run keeps counting.
				await warm.unlock();
				throw error;
			}
			await warm.unlock();
			await capacityLease.release();
			if (signal?.aborted) throw signal.reason;
			throw new GondolinSandboxError("sandbox warm-up failed", {
				cause: error,
			});
		} finally {
			warm.warmupMs = Math.round(performance.now() - startedAt);
		}
		await warm.unlock();
	}
	let checkpointLease = warm.lease;
	if (checkpointLease && options.warmCheckpoints) {
		const lease = checkpointLease;
		let buildId: string | undefined;
		try {
			buildId = VmCheckpoint.load(lease.path).guestAssetBuildId;
		} catch {
			warm.outcome = "resume-failed";
			warm.failure = "resume-failed";
		}
		if (
			buildId !== undefined &&
			buildId !== options.warmCheckpoints.guestAssetBuildId
		) {
			warm.outcome = "build-mismatch";
		}
		if (buildId !== options.warmCheckpoints.guestAssetBuildId) {
			await lease.release();
			checkpointLease = undefined;
		}
	}
	let vm: VM;
	try {
		if (checkpointLease) {
			const lease = checkpointLease;
			try {
				vm = await VmCheckpoint.load(lease.path).resume<VM>(vmOptions(mounts));
			} catch {
				// A checkpoint that will not resume is recorded and the attempt
				// boots cold, so no later attempt retries it until the key changes.
				if (warm.key && options.warmCheckpoints) {
					await options.warmCheckpoints.store
						.recordFailure(warm.key, "resume-failed")
						.catch(() => {});
				}
				warm.outcome = "resume-failed";
				warm.failure = "resume-failed";
				await lease.release();
				checkpointLease = undefined;
				vm = await VM.create(vmOptions(mounts));
			}
		} else {
			vm = await VM.create(vmOptions(mounts));
		}
	} catch (error) {
		await checkpointLease?.release();
		await capacityLease.release();
		throw new GondolinSandboxError("sandbox construction failed", {
			cause: error,
		});
	}
	const boot: SandboxBootRecord = {
		mode: checkpointLease ? "warm" : "cold",
		warmup: warm.outcome,
		...(warm.key ? { checkpointKey: warm.key } : {}),
		...(warm.failure ? { failure: warm.failure } : {}),
		...(warm.warmupMs !== undefined ? { warmupMs: warm.warmupMs } : {}),
	};
	try {
		await vm.start();
		const hostPid = vm.getHostPid();
		if (hostPid === null) {
			throw new GondolinSandboxError("started VM has no host PID");
		}
		const hostProcessIdentity = await captureQemuProcessIdentity(hostPid);
		await bindDependencyDirectories(vm, dependencies);
		let closed = false;
		let closePromise: Promise<void> | undefined;
		const close = () => {
			if (closed) return Promise.resolve();
			closePromise ??= closeStartedVm(vm, capacityLease, checkpointLease)
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
			dependencies,
			boot,
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
			await closeStartedVm(vm, capacityLease, checkpointLease);
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
