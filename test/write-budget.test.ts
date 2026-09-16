import { MemoryProvider } from "@earendil-works/gondolin";
import { describe, expect, it } from "vitest";
import { withWriteBudget as spikeWithWriteBudget } from "../spike/gondolin/write-budget.js";
import {
	WorkspaceWriteBudgetError,
	withWriteBudget,
	workspaceBudgetNotice,
} from "../src/sandbox/write-budget.js";

describe("workspace write budget", () => {
	it("rejects writes that exceed the cumulative limit", async () => {
		const { provider, budget } = withWriteBudget(new MemoryProvider(), 10);
		const handle = await provider.open("/output", "w");
		await handle.write(Buffer.from("123456"), 0, 6, 0);

		await expect(handle.write(Buffer.from("78901"), 0, 5, 6)).rejects.toThrow(
			"workspace write budget exceeded",
		);
		expect(budget.reservedBytes).toBe(6);
		expect(budget.remainingBytes).toBe(4);
		await handle.close();
	});

	it("refuses exhausting writes with a typed EDQUOT error", async () => {
		const { provider, budget } = withWriteBudget(new MemoryProvider(), 4);
		expect(budget.exhausted).toBe(false);
		expect(budget.refusals).toBe(0);
		const handle = await provider.open("/output", "w");
		const refusal = await handle
			.write(Buffer.from("123456"), 0, 6, 0)
			.then(() => undefined)
			.catch((error: unknown) => error);

		expect(refusal).toBeInstanceOf(WorkspaceWriteBudgetError);
		const error = refusal as WorkspaceWriteBudgetError;
		expect(error.code).toBe("EDQUOT");
		// Gondolin maps `code` through its Linux errno table, so the guest sees
		// EDQUOT (122) instead of the generic EIO used for untyped hook errors.
		expect(error.errno).toBe(122);
		expect(error.requestedBytes).toBe(6);
		expect(error.remainingBytes).toBe(4);
		expect(error.limitBytes).toBe(4);
		expect(budget.exhausted).toBe(true);
		expect(budget.refusals).toBe(1);
		expect(budget.reservedBytes).toBe(0);
		expect(workspaceBudgetNotice(budget)).toContain(
			"workspace write budget exhausted",
		);
		expect(workspaceBudgetNotice(budget)).toContain("EDQUOT");
		await handle.close();
	});

	it("exposes one implementation to the qualification spike", () => {
		expect(spikeWithWriteBudget).toBe(withWriteBudget);
	});

	it("rejects invalid limits", () => {
		expect(() => withWriteBudget(new MemoryProvider(), -1)).toThrow(
			"write budget must be a non-negative safe integer",
		);
	});
});
