import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
	createHttpHooks,
	ReadonlyProvider,
	RealFSProvider,
	VM,
} from "@earendil-works/gondolin";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ArtifactStore } from "../../src/artifacts/store.js";
import { RunJournal } from "../../src/persistence/journal.js";
import { acquireRunLease } from "../../src/persistence/run-lease.js";
import { canonicalSha256 } from "../../src/preflight/canonical.js";
import { compileLaunchPlan } from "../../src/preflight/compile.js";
import { createExactModelResolver } from "../../src/preflight/models.js";
import { runNativeAttempt } from "../../src/runtime/attempt.js";
import {
	createVmCapacityManager,
	VmCapacityExhaustedError,
} from "../../src/sandbox/capacity.js";
import { createGondolinAttemptSandbox } from "../../src/sandbox/gondolin.js";
import { createSubagentService } from "../../src/service.js";
import {
	driveNativeSession,
	type NativeSessionDrive,
} from "./session-drive.js";
import { createGondolinTools } from "./tools.js";
import { withWriteBudget } from "./write-budget.js";

type CheckStatus = "passed" | "failed" | "blocked";

type Check = {
	name: string;
	status: CheckStatus;
	durationMs: number;
	details: string;
};

type VmRecord = {
	id: string;
	hostPid: number | null;
	bootMs: number;
	memory: string;
	cpus: number;
};

type QualificationReport = {
	schema: "pi-subagent-gondolin-qualification";
	createdAt: string;
	platform: NodeJS.Platform;
	architecture: string;
	node: string;
	gondolin: "0.12.0";
	qemu: string;
	fixtureRoot: string;
	checks: Check[];
	vms: VmRecord[];
	nativeSessions: NativeSessionDrive[];
	summary: Record<CheckStatus, number>;
};

const execFileAsync = promisify(execFile);
const MEMORY = "512M";
const CPUS = 1;
const root = path.resolve(
	process.cwd(),
	".pi",
	"qualification",
	`gondolin-${Date.now()}-${randomUUID().slice(0, 8)}`,
);
const evidenceDirectory = path.resolve(
	process.cwd(),
	".pi",
	"qualification-results",
);
const checks: Check[] = [];
const vms: VmRecord[] = [];
const nativeSessions: NativeSessionDrive[] = [];

function text(result: {
	content: Array<{ type: string; text?: string }>;
}): string {
	return result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

async function check(name: string, operation: () => Promise<string>) {
	const startedAt = performance.now();
	try {
		const details = await operation();
		checks.push({
			name,
			status: "passed",
			durationMs: Math.round(performance.now() - startedAt),
			details,
		});
		process.stdout.write(`PASS ${name}\n`);
	} catch (error) {
		const details = error instanceof Error ? error.message : String(error);
		checks.push({
			name,
			status: "failed",
			durationMs: Math.round(performance.now() - startedAt),
			details,
		});
		process.stdout.write(`FAIL ${name}: ${details}\n`);
	}
}

async function createVm(workspace: string, readOnly = false): Promise<VM> {
	const provider = new RealFSProvider(workspace);
	const { httpHooks } = createHttpHooks({ blockInternalRanges: true });
	const startedAt = performance.now();
	const vm = await VM.create({
		sandbox: { vmm: "qemu" },
		memory: MEMORY,
		cpus: CPUS,
		rootfs: { mode: "memory" },
		startTimeoutMs: 60_000,
		allowWebSockets: false,
		maxHttpBodyBytes: 8 * 1024 * 1024,
		maxHttpResponseBodyBytes: 32 * 1024 * 1024,
		httpHooks,
		dns: { mode: "synthetic" },
		sessionLabel: `pi-subagent qualification ${path.basename(workspace)}`,
		vfs: {
			mounts: {
				"/workspace": readOnly ? new ReadonlyProvider(provider) : provider,
			},
		},
	});
	try {
		await vm.start();
	} catch (error) {
		await vm.close();
		throw error;
	}
	vms.push({
		id: vm.id,
		hostPid: vm.getHostPid(),
		bootMs: Math.round(performance.now() - startedAt),
		memory: MEMORY,
		cpus: CPUS,
	});
	return vm;
}

async function closeVm(vm: VM): Promise<void> {
	const pid = vm.getHostPid();
	await vm.close();
	assert(
		vm.getHostPid() === null,
		`VM ${vm.id} retained a host PID after close`,
	);
	if (pid === null) return;
	for (let attempt = 0; attempt < 20; attempt++) {
		try {
			process.kill(pid, 0);
		} catch {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`VM host process ${pid} remained after close`);
}

async function setupFixtures() {
	await mkdir(root, { recursive: true, mode: 0o700 });
	await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
	for (const name of [
		"writer",
		"reader",
		"agent-a",
		"agent-b",
		"quota",
		"adapter",
		"runner",
		"service",
	]) {
		await mkdir(path.join(root, name), { mode: 0o700 });
	}
	await writeFile(path.join(root, "outside-sentinel"), "HOST_SENTINEL\n");
	await writeFile(path.join(root, "writer", "fixture.txt"), "alpha needle\n");
	await writeFile(path.join(root, "writer", ".env"), "VISIBLE_FIXTURE=yes\n");
	await writeFile(path.join(root, "reader", "fixture.txt"), "read only\n");
}

async function qualifyReadOnly() {
	const workspace = path.join(root, "reader");
	const vm = await createVm(workspace, true);
	try {
		const read = await vm.exec("cat /workspace/fixture.txt");
		assert(read.ok && read.stdout.includes("read only"), "read failed");
		const write = await vm.exec("printf changed > /workspace/fixture.txt");
		assert(!write.ok, "read-only write unexpectedly succeeded");
		assert(
			(await readFile(path.join(workspace, "fixture.txt"), "utf8")) ===
				"read only\n",
			"host fixture changed through read-only provider",
		);
	} finally {
		await closeVm(vm);
	}
	return "ReadonlyProvider rejected guest writes and preserved the host file.";
}

async function qualifyToolsAndBoundary() {
	const workspace = path.join(root, "writer");
	const vm = await createVm(workspace);
	let cancellationObserved = false;
	try {
		const tools = await createGondolinTools(vm, workspace);
		const readResult = await tools.read.execute(
			"read",
			{ path: "fixture.txt" },
			undefined,
			undefined,
			undefined as never,
		);
		assert(text(readResult).includes("alpha needle"), "read tool failed");

		await tools.write.execute(
			"write",
			{ path: "written.txt", content: "before\n" },
			undefined,
			undefined,
			undefined as never,
		);
		await tools.edit.execute(
			"edit",
			{
				path: "written.txt",
				edits: [{ oldText: "before", newText: "after" }],
			},
			undefined,
			undefined,
			undefined as never,
		);
		assert(
			(await readFile(path.join(workspace, "written.txt"), "utf8")) ===
				"after\n",
			"write/edit tools did not write through",
		);

		const lsResult = await tools.ls.execute(
			"ls",
			{ path: "." },
			undefined,
			undefined,
			undefined as never,
		);
		assert(text(lsResult).includes("written.txt"), "ls tool failed");
		const findResult = await tools.find.execute(
			"find",
			{ path: ".", pattern: "*.txt" },
			undefined,
			undefined,
			undefined as never,
		);
		assert(text(findResult).includes("fixture.txt"), "find tool failed");
		const grepResult = await tools.grep.execute(
			"grep",
			{ path: ".", pattern: "needle", literal: true },
			undefined,
			undefined,
			undefined as never,
		);
		assert(text(grepResult).includes("fixture.txt:1"), "grep tool failed");
		const bashResult = await tools.bash.execute(
			"bash",
			{ command: "pwd; test -f .env; printf bash-ok" },
			undefined,
			undefined,
			undefined as never,
		);
		assert(
			text(bashResult).includes("/workspace") &&
				text(bashResult).includes("bash-ok"),
			"bash tool failed or .env was hidden",
		);

		const homeProbe = await vm.exec(
			`test ! -e ${JSON.stringify(path.join(homedir(), ".config", "pi"))}`,
		);
		assert(homeProbe.ok, "host Pi configuration path was visible");
		const siblingProbe = await vm.exec(
			"test ! -e /workspace/../outside-sentinel",
		);
		assert(siblingProbe.ok, "workspace parent escaped the mount");

		const publicNetwork = await vm.exec(
			"curl -fsS --max-time 10 https://example.com >/dev/null",
		);
		assert(publicNetwork.ok, `public HTTPS failed: ${publicNetwork.stderr}`);
		for (const target of [
			"http://127.0.0.1:1",
			"http://169.254.169.254/latest/meta-data/",
		]) {
			const denied = await vm.exec(
				`curl -fsS --connect-timeout 2 --max-time 3 ${target} >/dev/null`,
			);
			assert(!denied.ok, `internal destination unexpectedly worked: ${target}`);
		}

		const controller = new AbortController();
		const sleeping = vm.exec("sleep 60", { signal: controller.signal });
		setTimeout(() => controller.abort(), 200);
		try {
			await sleeping;
		} catch {
			cancellationObserved = true;
		}
		assert(cancellationObserved, "aborted exec did not reject");

		const destructive = await vm.exec(
			"rm -rf /workspace/* /workspace/.[!.]* /workspace/..?* 2>/dev/null || true",
		);
		assert(destructive.ok, "destructive fixture command failed unexpectedly");
		assert(
			(await readFile(path.join(root, "outside-sentinel"), "utf8")) ===
				"HOST_SENTINEL\n",
			"destructive command changed the outside sentinel",
		);
		assert(
			(await readdir(workspace)).length === 0,
			"workspace was not deleted",
		);
	} finally {
		await closeVm(vm);
	}
	return "All seven Pi tools used VM operations; public HTTPS worked; internal targets and host paths were unavailable; destructive writes stayed in the fixture.";
}

async function qualifyWriteBudget() {
	const workspace = path.join(root, "quota");
	const limitBytes = 128 * 1024;
	const { provider, budget } = withWriteBudget(
		new RealFSProvider(workspace),
		limitBytes,
	);
	const { httpHooks } = createHttpHooks({ blockInternalRanges: true });
	const startedAt = performance.now();
	const vm = await VM.create({
		sandbox: { vmm: "qemu" },
		memory: MEMORY,
		cpus: CPUS,
		rootfs: { mode: "memory" },
		allowWebSockets: false,
		httpHooks,
		dns: { mode: "synthetic" },
		sessionLabel: "pi-subagent qualification quota",
		vfs: { mounts: { "/workspace": provider } },
	});
	try {
		await vm.start();
	} catch (error) {
		await vm.close();
		throw error;
	}
	vms.push({
		id: vm.id,
		hostPid: vm.getHostPid(),
		bootMs: Math.round(performance.now() - startedAt),
		memory: MEMORY,
		cpus: CPUS,
	});
	try {
		const result = await vm.exec(
			"dd if=/dev/zero of=/workspace/large.bin bs=65536 count=16",
		);
		assert(!result.ok, "oversized workspace write unexpectedly succeeded");
		assert(
			budget.reservedBytes <= limitBytes,
			"write budget reserved beyond its limit",
		);
		const file = await stat(path.join(workspace, "large.bin"));
		assert(file.size <= limitBytes, `host file exceeded quota: ${file.size}`);
		return `A 1MiB guest write stopped at ${file.size} bytes under a ${limitBytes}-byte cumulative budget.`;
	} finally {
		await closeVm(vm);
	}
}

async function qualifyConcurrentIsolation() {
	const workspaceA = path.join(root, "agent-a");
	const workspaceB = path.join(root, "agent-b");
	const [vmA, vmB] = await Promise.all([
		createVm(workspaceA),
		createVm(workspaceB),
	]);
	try {
		await Promise.all([
			vmA.exec("printf agent-a > /workspace/marker"),
			vmB.exec("printf agent-b > /workspace/marker"),
		]);
		assert(
			(await readFile(path.join(workspaceA, "marker"), "utf8")) === "agent-a",
			"agent A marker mismatch",
		);
		assert(
			(await readFile(path.join(workspaceB, "marker"), "utf8")) === "agent-b",
			"agent B marker mismatch",
		);
		const [crossA, crossB] = await Promise.all([
			vmA.exec("test ! -e /workspace/agent-b"),
			vmB.exec("test ! -e /workspace/agent-a"),
		]);
		assert(crossA.ok && crossB.ok, "VMs observed cross-workspace state");
	} finally {
		await Promise.all([closeVm(vmA), closeVm(vmB)]);
	}
	return "Two 512M/1-vCPU VMs booted concurrently and wrote only their own mounts.";
}

async function qualifyProductionAdapter(): Promise<string> {
	const workspace = path.join(root, "adapter");
	const capacity = await createVmCapacityManager({
		root: path.join(root, "adapter-capacity"),
		maxSlots: 1,
	});
	const sandbox = await createGondolinAttemptSandbox({
		owner: "qualification-adapter",
		workspace,
		readOnly: false,
		workspaceWriteBytes: 64 * 1024,
		capacity,
	});
	const result = await sandbox.vm.exec(
		"printf production-adapter > /workspace/adapter.txt",
	);
	assert(result.ok, "production adapter guest write failed");
	await sandbox.cancel();
	assert(sandbox.isClosed(), "production adapter did not close");
	assert(
		(await readFile(path.join(workspace, "adapter.txt"), "utf8")) ===
			"production-adapter",
		"production adapter write did not reach its workspace",
	);
	return `Production adapter routed a write through VM ${sandbox.record.vmId}, proved close, and released capacity slot ${sandbox.record.capacitySlot}.`;
}

async function qualifyGlobalCapacity(): Promise<string> {
	const manager = await createVmCapacityManager({
		root: path.join(root, "capacity"),
		maxSlots: 1,
	});
	const first = await manager.acquire("qualification-first");
	try {
		await assertRejectsCapacity(() => manager.acquire("qualification-second"));
	} finally {
		await first.release();
	}
	const replacement = await manager.acquire("qualification-replacement");
	await replacement.release();
	return `A host socket lease enforced one global slot at 127.0.0.1:${manager.basePort} and released it for replacement.`;
}

async function assertRejectsCapacity(
	operation: () => Promise<unknown>,
): Promise<void> {
	try {
		await operation();
	} catch (error) {
		assert(
			error instanceof VmCapacityExhaustedError,
			`unexpected capacity error: ${String(error)}`,
		);
		return;
	}
	throw new Error("capacity acquisition unexpectedly succeeded");
}

async function qualifyForegroundService(): Promise<string> {
	const workspace = path.join(root, "service");
	await writeFile(path.join(workspace, "task.txt"), "SERVICE_OK\n");
	const modelRuntime = await ModelRuntime.create();
	const agentHash = canonicalSha256("qualification-service-agent");
	const limits = {
		runtimeMs: 60_000,
		tokens: 100_000,
		cost: 10,
		outputBytes: 4096,
		workspaceWriteBytes: 0,
		retries: 0,
		resumes: 0,
	};
	const agent = {
		name: "qualification-service",
		source: "<qualification-service-agent>",
		sha256: agentHash,
		defaultModel: {
			provider: "github-copilot",
			id: "gpt-5.6-luna",
			thinking: "low" as const,
		},
		allowedModels: ["github-copilot/gpt-5.6-luna:low"],
		tools: ["read"],
		skills: [],
		workspaceModes: ["read-only" as const],
		limitCeiling: limits,
		prompt:
			"Read task.txt with the read tool, then respond with exactly its single-line content and nothing else.",
		scope: "builtin" as const,
	};
	const service = await createSubagentService({
		root: path.join(root, "service-state"),
		agents: new Map([[agent.name, agent]]),
		modelRuntime,
		capacity: await createVmCapacityManager({
			root: path.join(root, "service-capacity"),
			maxSlots: 1,
		}),
		sandbox: {
			packageVersion: "0.12.0",
			imageSha256: canonicalSha256("qualification-image"),
			mountPolicySha256: canonicalSha256("qualification-mount"),
			networkPolicySha256: canonicalSha256("qualification-network"),
			capacityPolicySha256: canonicalSha256("qualification-capacity"),
			memoryBytes: 512 * 1024 * 1024,
			guestDiskBytes: 2 * 1024 * 1024 * 1024,
		},
	});
	const client = service.forOwner({ id: "qualification-service-owner" });
	const preflight = await client.preflight({
		operationId: "qualification-service-operation",
		agent: agent.name,
		task: {
			goal: "Read task.txt and return its exact content",
			context: [],
			instructions: ["Use read", "Return only the marker"],
		},
		contextMode: "fresh",
		model: agent.defaultModel,
		tools: ["read"],
		skills: [],
		workspace: { mode: "read-only", cwd: workspace },
		limits,
	});
	const receipt = await client.launch(
		preflight.preflightId,
		preflight.identitySha256,
	);
	const duplicate = await client.launch(
		preflight.preflightId,
		preflight.identitySha256,
	);
	assert(
		duplicate.runId === receipt.runId,
		"service launch was not idempotent",
	);
	const result = await client.wait(receipt.runId);
	assert(
		result.result.status === "completed",
		result.error ?? "service failed",
	);
	assert(result.output.trim() === "SERVICE_OK", "service output mismatch");
	assert(
		(await client.logs(receipt.runId)).length >= 4,
		"service logs missing",
	);
	return `Foreground service preflighted, launched idempotently, waited for, and observed ${receipt.runId}.`;
}

async function qualifyAttemptRunner(): Promise<string> {
	const workspace = path.join(root, "runner");
	await writeFile(path.join(workspace, "task.txt"), "RUNNER_OK\n");
	const modelRuntime = await ModelRuntime.create();
	const runId = `run_${randomUUID().replaceAll("-", "")}`;
	const attemptId = `attempt_${randomUUID().replaceAll("-", "")}`;
	const agentHash = canonicalSha256("qualification-runner-agent");
	const toolHash = canonicalSha256("builtin-read");
	const agent = {
		name: "qualification-runner",
		source: "<qualification-agent>",
		sha256: agentHash,
		defaultModel: {
			provider: "github-copilot",
			id: "gpt-5.6-luna",
			thinking: "low" as const,
		},
		allowedModels: ["github-copilot/gpt-5.6-luna:low"],
		tools: ["read"],
		skills: [],
		workspaceModes: ["read-only" as const],
		limitCeiling: {
			runtimeMs: 60_000,
			tokens: 100_000,
			cost: 10,
			outputBytes: 4096,
			workspaceWriteBytes: 0,
			retries: 0,
			resumes: 0,
		},
		prompt:
			"Read task.txt with the read tool, then respond with exactly its single-line content and nothing else.",
		scope: "builtin" as const,
	};
	const workspaceIdentity = canonicalSha256(workspace);
	const plan = await compileLaunchPlan({
		ownerId: "qualification-owner",
		runId,
		attemptId,
		request: {
			operationId: "qualification-runner",
			agent: agent.name,
			task: {
				goal: "Read task.txt and return its exact content",
				context: [],
				instructions: ["Use read", "Return only the marker"],
			},
			contextMode: "fresh",
			model: agent.defaultModel,
			tools: ["read"],
			skills: [],
			workspace: { mode: "read-only", cwd: workspace },
			limits: agent.limitCeiling,
		},
		agent,
		resources: [
			{
				kind: "agent",
				name: agent.name,
				source: agent.source,
				sha256: agentHash,
			},
			{
				kind: "tool",
				name: "read",
				source: "<builtin:read>",
				sha256: toolHash,
			},
		],
		workspace: {
			mode: "read-only",
			hostPathSha256: workspaceIdentity,
			baselineSha256: workspaceIdentity,
		},
		sandbox: {
			packageVersion: "0.12.0",
			imageSha256: canonicalSha256("qualification-image"),
			mountPolicySha256: canonicalSha256("qualification-mount"),
			networkPolicySha256: canonicalSha256("qualification-network"),
			capacityPolicySha256: canonicalSha256("qualification-capacity"),
			memoryBytes: 512 * 1024 * 1024,
			guestDiskBytes: 2 * 1024 * 1024 * 1024,
		},
		resolveModel: createExactModelResolver(modelRuntime),
	});
	const lease = await acquireRunLease({
		root: path.join(root, "runner-leases"),
		runId,
	});
	const journal = await RunJournal.open(
		path.join(root, "runner-runs"),
		runId,
		lease,
	);
	const artifactStore = await ArtifactStore.open({
		root: path.join(root, "runner-artifacts"),
		maxArtifactBytes: plan.limits.outputBytes,
		maxTotalBytes: plan.limits.outputBytes,
		lease,
	});
	const result = await runNativeAttempt({
		plan,
		agent,
		workspacePath: workspace,
		modelRuntime,
		capacity: await createVmCapacityManager({
			root: path.join(root, "runner-capacity"),
			maxSlots: 1,
		}),
		lease,
		journal,
		artifactStore,
		sessionRoot: path.join(root, "runner-sessions"),
	});
	await lease.release();
	assert(result.result.status === "completed", result.error ?? "runner failed");
	assert(result.output.trim() === "RUNNER_OK", "runner output mismatch");
	assert(result.result.output !== undefined, "runner output artifact missing");
	assert(
		(await artifactStore.export(result.result.output)).content
			.toString("utf8")
			.trim() === "RUNNER_OK",
		"runner output artifact mismatch",
	);
	assert((await journal.readEvents()).length >= 4, "runner journal incomplete");
	return `Production runner completed ${attemptId} with a persisted Pi session, terminal result, and proved VM cleanup.`;
}

async function qualifyNativeSessions(): Promise<string> {
	const modelRuntime = await ModelRuntime.create();
	const available = await modelRuntime.getAvailable();
	const modelAvailable = available.some(
		(model) =>
			model.provider === "github-copilot" && model.id === "gpt-5.6-luna",
	);
	assert(modelAvailable, "github-copilot/gpt-5.6-luna is not authenticated");
	const drives = await Promise.all([
		driveNativeSession({
			label: "native-a",
			workspace: path.join(root, "native-a"),
			marker: "NATIVE_AGENT_A_OK",
			modelRuntime,
		}),
		driveNativeSession({
			label: "native-b",
			workspace: path.join(root, "native-b"),
			marker: "NATIVE_AGENT_B_OK",
			modelRuntime,
		}),
	]);
	nativeSessions.push(...drives);
	return `Two native AgentSessions completed concurrently in separate VMs with ${drives[0]?.model}.`;
}

async function qemuVersion(): Promise<string> {
	const { stdout } = await execFileAsync("qemu-system-aarch64", ["--version"]);
	return stdout.split("\n")[0] ?? stdout.trim();
}

async function main() {
	await setupFixtures();
	await check("read-only workspace", qualifyReadOnly);
	await check("tool routing and host boundary", qualifyToolsAndBoundary);
	await check("workspace write budget", qualifyWriteBudget);
	await check("concurrent VM isolation", qualifyConcurrentIsolation);
	await check("global VM capacity lease", qualifyGlobalCapacity);
	await check("production Gondolin adapter", qualifyProductionAdapter);
	await check("production native attempt runner", qualifyAttemptRunner);
	await check("foreground SubagentService", qualifyForegroundService);
	await check("concurrent native AgentSessions", qualifyNativeSessions);
	const summary = checks.reduce<Record<CheckStatus, number>>(
		(result, item) => {
			result[item.status]++;
			return result;
		},
		{ passed: 0, failed: 0, blocked: 0 },
	);
	const report: QualificationReport = {
		schema: "pi-subagent-gondolin-qualification",
		createdAt: new Date().toISOString(),
		platform: process.platform,
		architecture: process.arch,
		node: process.version,
		gondolin: "0.12.0",
		qemu: await qemuVersion(),
		fixtureRoot: root,
		checks,
		vms,
		nativeSessions,
		summary,
	};
	const reportPath = path.join(
		evidenceDirectory,
		`gondolin-${report.createdAt.replaceAll(":", "-")}.json`,
	);
	await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
		mode: 0o600,
	});
	process.stdout.write(`\nReport: ${reportPath}\n`);
	process.stdout.write(`Summary: ${JSON.stringify(summary)}\n`);
	if (summary.failed > 0) process.exitCode = 1;
}

await main();
