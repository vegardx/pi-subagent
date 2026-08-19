import { randomUUID } from "node:crypto";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createVmCapacityManager } from "../src/sandbox/capacity.js";
import {
	createGondolinAttemptSandbox,
	GondolinSandboxError,
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
});
