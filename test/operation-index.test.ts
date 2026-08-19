import { randomUUID } from "node:crypto";
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PersistenceCorruptionError } from "../src/persistence/journal.js";
import {
	OperationConflictError,
	OperationIndex,
} from "../src/persistence/operation-index.js";

const requestA = "a".repeat(64);
const requestB = "b".repeat(64);

function fixtureRoot(name: string): string {
	return path.resolve(".pi", "test-operations", `${name}-${randomUUID()}`);
}

describe("operation idempotency index", () => {
	it("lets exactly one concurrent claim create the mapping", async () => {
		const index = await OperationIndex.open(fixtureRoot("concurrent"));
		const claims = await Promise.all(
			Array.from({ length: 20 }, () =>
				index.claim({
					ownerId: "owner-a",
					operationId: "operation-a",
					requestSha256: requestA,
					runId: "run_operation",
				}),
			),
		);
		expect(claims.filter((claim) => claim.created)).toHaveLength(1);
		expect(new Set(claims.map((claim) => claim.record.runId))).toEqual(
			new Set(["run_operation"]),
		);
	});

	it("rejects reuse with a different request or run", async () => {
		const index = await OperationIndex.open(fixtureRoot("conflict"));
		await index.claim({
			ownerId: "owner-a",
			operationId: "operation-a",
			requestSha256: requestA,
			runId: "run_first",
		});
		await expect(
			index.claim({
				ownerId: "owner-a",
				operationId: "operation-a",
				requestSha256: requestB,
				runId: "run_second",
			}),
		).rejects.toBeInstanceOf(OperationConflictError);
	});

	it("isolates identical operation IDs by owner", async () => {
		const index = await OperationIndex.open(fixtureRoot("owners"));
		const first = await index.claim({
			ownerId: "owner-a",
			operationId: "same-operation",
			requestSha256: requestA,
			runId: "run_ownera",
		});
		const second = await index.claim({
			ownerId: "owner-b",
			operationId: "same-operation",
			requestSha256: requestA,
			runId: "run_ownerb",
		});
		expect(first.created).toBe(true);
		expect(second.created).toBe(true);
	});

	it("fails closed on a corrupt existing record", async () => {
		const root = fixtureRoot("corrupt");
		const index = await OperationIndex.open(root);
		await index.claim({
			ownerId: "owner-a",
			operationId: "operation-a",
			requestSha256: requestA,
			runId: "run_corrupt",
		});
		const [recordPath] = (await readdir(root)).filter((name) =>
			name.endsWith(".json"),
		);
		expect(recordPath).toBeDefined();
		await writeFile(path.join(root, recordPath ?? "missing"), "{broken");
		await expect(
			index.claim({
				ownerId: "owner-a",
				operationId: "operation-a",
				requestSha256: requestA,
				runId: "run_corrupt",
			}),
		).rejects.toBeInstanceOf(PersistenceCorruptionError);
	});
});
