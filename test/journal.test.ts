import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	PersistenceCorruptionError,
	RunJournal,
} from "../src/persistence/journal.js";

function fixtureRoot(name: string): string {
	return path.resolve(".pi", "test-journal", `${name}-${randomUUID()}`);
}

describe("run journal", () => {
	it("serializes concurrent appends with durable sequence numbers", async () => {
		const root = fixtureRoot("append");
		const journal = await RunJournal.open(root, "run_abc123");
		const events = await Promise.all(
			Array.from({ length: 10 }, (_, index) =>
				journal.append("observed", { index }),
			),
		);
		expect(events.map((event) => event.sequence)).toEqual([
			1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
		]);
		const reopened = await RunJournal.open(root, "run_abc123");
		expect(
			(await reopened.readEvents()).map((event) => event.sequence),
		).toEqual(events.map((event) => event.sequence));
		expect((await stat(root)).mode & 0o777).toBe(0o700);
		expect((await stat(journal.journalPath)).mode & 0o777).toBe(0o600);
	});

	it("ignores one unterminated tail and rejects interior corruption", async () => {
		const root = fixtureRoot("torn");
		const journal = await RunJournal.open(root, "run_torn");
		await journal.append("created", {});
		await appendFile(journal.journalPath, '{"schema":"partial"');
		const recovered = await RunJournal.open(root, "run_torn");
		expect(await recovered.readEvents()).toHaveLength(1);
		const continued = await recovered.append("continued", {});
		expect(continued.sequence).toBe(2);

		await appendFile(journal.journalPath, "{broken}\n");
		await expect(RunJournal.open(root, "run_torn")).rejects.toBeInstanceOf(
			PersistenceCorruptionError,
		);
	});

	it("writes and validates atomic snapshots", async () => {
		const root = fixtureRoot("snapshot");
		const journal = await RunJournal.open(root, "run_snapshot");
		await journal.append("created", {});
		await journal.writeSnapshot({ status: "active" });
		expect(await journal.readSnapshot()).toMatchObject({
			runId: "run_snapshot",
			lastSequence: 1,
			state: { status: "active" },
		});

		const invalid = JSON.parse(
			await readFile(journal.snapshotPath, "utf8"),
		) as {
			contractRevision: number;
		};
		invalid.contractRevision++;
		await writeFile(journal.snapshotPath, JSON.stringify(invalid));
		await expect(journal.readSnapshot()).rejects.toBeInstanceOf(
			PersistenceCorruptionError,
		);
	});

	it("rejects non-serializable data before writing", async () => {
		const root = fixtureRoot("serialization");
		const journal = await RunJournal.open(root, "run_serialization");
		await expect(journal.append("undefined", undefined)).rejects.toThrow(
			"not serializable",
		);
		await expect(journal.writeSnapshot(undefined)).rejects.toThrow(
			"not serializable",
		);
	});

	it("rejects oversized events before writing", async () => {
		const root = fixtureRoot("bounds");
		await mkdir(root, { recursive: true });
		const journal = await RunJournal.open(root, "run_bounds");
		await expect(
			journal.append("large", { value: "x".repeat(70 * 1024) }),
		).rejects.toThrow("journal event exceeds size limit");
		await expect(
			journal.writeSnapshot({ value: "x".repeat(1024 * 1024) }),
		).rejects.toThrow("run snapshot exceeds size limit");
		expect(await journal.readEvents()).toEqual([]);
	});
});
