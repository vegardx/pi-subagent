import { randomUUID } from "node:crypto";
import path from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "../src/artifacts/store.js";
import type { AgentLaunchPlan } from "../src/launch-contracts.js";
import { RunJournal } from "../src/persistence/journal.js";
import { acquireRunLease } from "../src/persistence/run-lease.js";
import type { DiscoveredAgent } from "../src/preflight/agents.js";
import { canonicalSha256 } from "../src/preflight/canonical.js";
import { runNativeAttempt } from "../src/runtime/attempt.js";
import { createAttemptDeadline } from "../src/runtime/deadline.js";
import type { VmCapacityManager } from "../src/sandbox/capacity.js";
import {
	createGondolinAttemptSandbox,
	type GondolinAttemptSandbox,
	GondolinSandboxError,
} from "../src/sandbox/gondolin.js";

vi.mock("../src/sandbox/gondolin.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/sandbox/gondolin.js")>()),
	createGondolinAttemptSandbox: vi.fn(),
}));

vi.mock("../src/preflight/models.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/preflight/models.js")>()),
	resolveExactPiModel: async () => ({ model: {} }),
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
	return {
		...original,
		getAgentDir: () => path.resolve(".pi", "test-attempt-deadline-agent"),
		DefaultResourceLoader: class {
			async reload() {}
		},
		SessionManager: {
			create: () => ({ appendMessage() {} }),
			open: () => ({ appendMessage() {} }),
		},
		// A session whose prompt never settles until it is aborted, so only the
		// attempt deadline can end the attempt.
		createAgentSession: async () => {
			let rejectPrompt: (error: unknown) => void = () => {};
			return {
				session: {
					messages: [],
					sessionId: "session-deadline",
					sessionFile: undefined,
					subscribe: () => () => {},
					prompt: () =>
						new Promise((_resolve, reject) => {
							rejectPrompt = reject;
						}),
					abort: async () => rejectPrompt(new Error("session aborted")),
					dispose() {},
					steer: async () => {},
					followUp: async () => {},
					agent: { waitForIdle: async () => {} },
				},
			};
		},
	};
});

const hash = "a".repeat(64);
const runId = "run_deadline";
const ATTEMPT_TIMEOUT_MS = 1_000;

function plan(): AgentLaunchPlan {
	const draft = {
		schema: "pi-subagent-launch" as const,
		contractRevision: 11 as const,
		operationId: "operation",
		ownerId: "owner",
		runId,
		attemptId: "attempt_deadline",
		agent: "worker",
		agentDisplayName: "Worker",
		agentPrompt: "Worker prompt",
		agentSource: "/agent",
		agentSha256: hash,
		agentScope: "global" as const,
		task: { goal: "goal", context: [], instructions: ["instruction"] },
		contextMode: "fresh" as const,
		model: {
			provider: "github-copilot",
			id: "gpt-5.6-luna",
			thinking: "low" as const,
		},
		modelSource: "request" as const,
		cwd: "/workspace" as const,
		tools: ["read"],
		preloadSkills: [],
		contextScopes: [],
		resources: [
			{
				kind: "agent" as const,
				name: "worker",
				source: "/agent",
				sha256: hash,
			},
			{ kind: "tool" as const, name: "read", source: "builtin", sha256: hash },
		],
		workspace: {
			mode: "read-only" as const,
			hostPathSha256: hash,
			baselineSha256: hash,
		},
		sandbox: {
			backend: "gondolin" as const,
			packageVersion: "0.12.0",
			imageSha256: hash,
			mountPolicySha256: hash,
			networkPolicySha256: hash,
			capacityPolicySha256: hash,
			memoryBytes: 1024 * 1024 * 1024,
			guestDiskBytes: 1024,
			workspaceWriteBytes: 0,
		},
		network: {
			mode: "public-egress" as const,
			blockInternalRanges: true as const,
		},
		limits: {
			cumulativeRuntimeMs: 60_000,
			attemptTimeoutMs: ATTEMPT_TIMEOUT_MS,
			totalTokens: 1000,
			cost: 1,
			outputBytes: 1024,
			workspaceWriteBytes: 0,
			retries: 0,
			resumes: 0,
		},
	};
	return { ...draft, identitySha256: canonicalSha256(draft) };
}

const agent: DiscoveredAgent = {
	name: "worker",
	displayName: "Worker",
	source: "/agent",
	sha256: hash,
	defaultModel: {
		provider: "github-copilot",
		id: "gpt-5.6-luna",
		thinking: "low",
	},
	allowedModels: ["github-copilot/gpt-5.6-luna:low"],
	tools: ["read"],
	preloadSkills: [],
	contextScopes: [],
	workspaceModes: ["read-only"],
	limitCeiling: plan().limits,
	memoryCeilingBytes: 1024 * 1024 * 1024,
	prompt: "Worker prompt",
	scope: "global",
};

function fakeSandbox(): GondolinAttemptSandbox {
	let closed = false;
	const close = async () => {
		closed = true;
	};
	return {
		record: {
			backend: "gondolin",
			packageVersion: "0.12.0",
			vmId: "vm-deadline",
			hostPid: 1,
			hostProcessIdentity:
				{} as GondolinAttemptSandbox["record"]["hostProcessIdentity"],
			capacityLeaseId: "lease",
			capacitySlot: 0,
			workspace: "/workspace",
			readOnly: true,
			memory: "1024M",
			cpus: 1,
			startedAt: new Date().toISOString(),
		},
		vm: {} as GondolinAttemptSandbox["vm"],
		tools: {} as GondolinAttemptSandbox["tools"],
		writeBudget: undefined,
		isClosed: () => closed,
		close,
		cancel: close,
	};
}

async function attempt() {
	const root = path.resolve(".pi", "test-attempt-deadline", randomUUID());
	const lease = await acquireRunLease({
		root: path.join(root, "leases"),
		runId,
	});
	const journal = await RunJournal.open(path.join(root, "runs"), runId, lease);
	const artifactStore = await ArtifactStore.open({
		root: path.join(root, "blobs"),
		maxArtifactBytes: 1024,
		maxTotalBytes: 4096,
		lease,
	});
	return runNativeAttempt({
		plan: plan(),
		agent,
		workspacePath: root,
		modelRuntime: {} as ModelRuntime,
		capacity: {} as VmCapacityManager,
		lease,
		journal,
		artifactStore,
		skills: { catalog: [], preloadPrompt: "" },
		contextFiles: { files: [] },
		sessionRoot: path.join(root, "sessions"),
	});
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("attempt deadline and VM boot", () => {
	afterEach(() => {
		vi.mocked(createGondolinAttemptSandbox).mockReset();
	});

	it("classifies a boot that outlasts attemptTimeoutMs as a sandbox launch", async () => {
		const message =
			"sandbox startup failed: guest did not become ready within 60 s at 1024M";
		vi.mocked(createGondolinAttemptSandbox).mockImplementation(async () => {
			await delay(ATTEMPT_TIMEOUT_MS + 300);
			throw new GondolinSandboxError(message);
		});
		const { result, error } = await attempt();
		expect(result.status).toBe("failed");
		expect(result.failure?.code).toBe("sandbox-launch");
		expect(result.failure?.message).toBe(message);
		expect(error).toBe(message);
		expect(result.runtimeMs).toBeGreaterThanOrEqual(ATTEMPT_TIMEOUT_MS + 300);
	});

	it("starts the attempt deadline once the VM is ready", async () => {
		const bootMs = 800;
		vi.mocked(createGondolinAttemptSandbox).mockImplementation(async () => {
			await delay(bootMs);
			return fakeSandbox();
		});
		const { result } = await attempt();
		expect(result.failure?.code).toBe("timeout");
		expect(result.failure?.message).toBe("Attempt runtime limit exceeded");
		// runtimeMs is wall-clock: boot plus the full attempt deadline.
		expect(result.runtimeMs).toBeGreaterThanOrEqual(
			bootMs + ATTEMPT_TIMEOUT_MS,
		);
	});
});

describe("attempt deadline clock", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("charges only running time and fires once the limit is charged", () => {
		vi.useFakeTimers();
		const deadline = createAttemptDeadline(1_000, () => Date.now());
		vi.advanceTimersByTime(300);
		deadline.pause();
		vi.advanceTimersByTime(5_000);
		expect(deadline.signal.aborted).toBe(false);
		expect(deadline.chargedMs()).toBe(300);
		deadline.resume();
		vi.advanceTimersByTime(699);
		expect(deadline.signal.aborted).toBe(false);
		vi.advanceTimersByTime(1);
		expect(deadline.signal.aborted).toBe(true);
		expect((deadline.signal.reason as DOMException).name).toBe("TimeoutError");
		expect(deadline.chargedMs()).toBe(1_000);
		deadline.resume();
		vi.advanceTimersByTime(5_000);
		expect(deadline.chargedMs()).toBe(1_000);
	});

	it("stops charging once disposed", () => {
		vi.useFakeTimers();
		const deadline = createAttemptDeadline(1_000, () => Date.now());
		vi.advanceTimersByTime(400);
		deadline.dispose();
		vi.advanceTimersByTime(5_000);
		expect(deadline.signal.aborted).toBe(false);
		expect(deadline.chargedMs()).toBe(400);
	});
});
