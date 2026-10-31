import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { classifyAttemptFailure } from "../src/runtime/failure.js";
import { createVmCapacityManager } from "../src/sandbox/capacity.js";
import {
	createGondolinAttemptSandbox,
	GONDOLIN_START_TIMEOUT_CODE,
	GondolinSandboxError,
} from "../src/sandbox/gondolin.js";

const startFailure = vi.hoisted(() => ({ error: new Error("unset") }));

vi.mock("@earendil-works/gondolin", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("@earendil-works/gondolin")>();
	return {
		...original,
		VM: {
			create: async () => ({
				id: "vm-start-failure",
				start: () => Promise.reject(startFailure.error),
				close: async () => {},
				getHostPid: () => null,
			}),
		},
	};
});

function codedError(message: string, code: string): Error {
	return Object.assign(new Error(message), { code });
}

async function startSandbox(options: {
	memoryBytes: number;
	startTimeoutMs?: number;
}) {
	const root = path.resolve(".pi", "test-gondolin-start", randomUUID());
	const workspace = path.join(root, "workspace");
	await mkdir(workspace, { recursive: true });
	const capacity = await createVmCapacityManager({
		root: path.join(root, "capacity"),
		maxSlots: 1,
	});
	const outcome = await createGondolinAttemptSandbox({
		owner: "start-failure",
		workspace,
		readOnly: true,
		workspaceWriteBytes: 0,
		capacity,
		...options,
	}).then(
		() => {
			throw new Error("sandbox unexpectedly started");
		},
		(error: unknown) => error,
	);
	const lease = await capacity.acquire("capacity-was-released");
	await lease.release();
	return outcome;
}

describe("Gondolin start failures", () => {
	beforeEach(() => {
		startFailure.error = new Error("unset");
	});

	it("names the readiness bound and memory from the launch, not the exception", async () => {
		startFailure.error = codedError(
			"vm startup timed out after 60000ms while waiting for guest readiness",
			GONDOLIN_START_TIMEOUT_CODE,
		);
		const error = await startSandbox({ memoryBytes: 1024 * 1024 * 1024 });
		expect(error).toBeInstanceOf(GondolinSandboxError);
		expect((error as Error).message).toBe(
			"sandbox startup failed: guest did not become ready within 60 s at 1024M",
		);

		const failure = classifyAttemptFailure({
			error,
			timedOut: false,
			sandboxCleanup: "not-needed",
			workspaceCleanup: "not-needed",
		});
		expect(failure.code).toBe("sandbox-launch");
		expect(failure.message).toBe(
			"sandbox startup failed: guest did not become ready within 60 s at 1024M",
		);
		expect(failure.message).not.toContain("60000ms");
	});

	it("uses the launch's own start timeout in the message", async () => {
		startFailure.error = codedError("anything", GONDOLIN_START_TIMEOUT_CODE);
		const error = await startSandbox({
			memoryBytes: 2 * 1024 * 1024 * 1024,
			startTimeoutMs: 1_500,
		});
		expect((error as Error).message).toBe(
			"sandbox startup failed: guest did not become ready within 1.5 s at 2048M",
		);
	});

	it("keeps every other start failure generic and drops its text", async () => {
		for (const raw of [
			new Error("qemu exited reading /Users/someone/.secret/token"),
			codedError("vm startup was cancelled", "vm_start_cancelled"),
		]) {
			startFailure.error = raw;
			const error = await startSandbox({ memoryBytes: 1024 * 1024 * 1024 });
			expect(error).toBeInstanceOf(GondolinSandboxError);
			expect((error as Error).message).toBe("sandbox startup failed");
			const failure = classifyAttemptFailure({
				error,
				timedOut: false,
				sandboxCleanup: "not-needed",
				workspaceCleanup: "not-needed",
			});
			expect(failure.code).toBe("sandbox-launch");
			expect(failure.message).toBe("sandbox startup failed");
		}
	});

	it("matches the code the installed Gondolin sets on a readiness timeout", async () => {
		const entry = fileURLToPath(
			import.meta.resolve("@earendil-works/gondolin"),
		);
		const core = await readFile(
			path.join(path.dirname(entry), "vm", "core.js"),
			"utf8",
		);
		expect(core).toContain(
			`timeoutError.code = "${GONDOLIN_START_TIMEOUT_CODE}";`,
		);
		expect(core).toContain('"guest readiness"');
	});
});
