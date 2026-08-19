import { describe, expect, it } from "vitest";
import { createHostProcessController } from "../src/reconciliation/process.js";

describe("host process reconciliation", () => {
	it("does not classify the current non-QEMU process as signalable", async () => {
		const observation = await createHostProcessController().observe(
			process.pid,
		);
		expect(observation.state).toBe("unknown");
		if (observation.state === "unknown") {
			expect(observation.reason).toContain("qualified QEMU");
		}
	});
});
