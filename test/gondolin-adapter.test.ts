import { randomUUID } from "node:crypto";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createVmCapacityManager } from "../src/sandbox/capacity.js";
import {
	createGondolinAttemptSandbox,
	GondolinSandboxError,
	guestMemorySize,
} from "../src/sandbox/gondolin.js";

describe("production Gondolin adapter", () => {
	it("does not consume capacity for an invalid workspace", async () => {
		const root = path.resolve(".pi", "test-gondolin-adapter", randomUUID());
		const capacity = await createVmCapacityManager({
			root: path.join(root, "capacity"),
			maxSlots: 1,
		});
		await expect(
			createGondolinAttemptSandbox({
				owner: "invalid-workspace",
				workspace: path.join(root, "missing"),
				readOnly: true,
				workspaceWriteBytes: 0,
				memoryBytes: 512 * 1024 * 1024,
				capacity,
			}),
		).rejects.toBeInstanceOf(GondolinSandboxError);
		const lease = await capacity.acquire("proof-capacity-remains");
		expect(lease.record.slot).toBe(0);
		await lease.release();
	});

	it("uses a distinct sandbox error type", () => {
		expect(new GondolinSandboxError("failure").name).toBe(
			"GondolinSandboxError",
		);
	});

	it("passes the resolved plan memory to the guest without a host default", () => {
		expect(guestMemorySize(512 * 1024 * 1024)).toBe("512M");
		expect(guestMemorySize(2 * 1024 * 1024 * 1024)).toBe("2048M");
		for (const invalid of [0, -512 * 1024 * 1024, 1024, 1.5 * 1024 * 1024]) {
			expect(() => guestMemorySize(invalid)).toThrow(
				"sandbox memory must be a positive whole number of MiB",
			);
		}
	});
});
