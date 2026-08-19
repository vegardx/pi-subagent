import { MemoryProvider } from "@earendil-works/gondolin";
import { describe, expect, it } from "vitest";
import { withWriteBudget } from "../spike/gondolin/write-budget.js";

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

	it("rejects invalid limits", () => {
		expect(() => withWriteBudget(new MemoryProvider(), -1)).toThrow(
			"write budget must be a non-negative safe integer",
		);
	});
});
