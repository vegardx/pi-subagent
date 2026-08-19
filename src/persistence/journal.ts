import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, stat } from "node:fs/promises";
import path from "node:path";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { CONTRACT_REVISION, type RunId, RunIdSchema } from "../contracts.js";

const MAX_EVENT_BYTES = 64 * 1024;
const MAX_JOURNAL_BYTES = 16 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 1024 * 1024;

export const JournalEventSchema = Type.Object(
	{
		schema: Type.Literal("pi-subagent-event"),
		contractRevision: Type.Literal(CONTRACT_REVISION),
		sequence: Type.Integer({ minimum: 1 }),
		eventId: Type.String({ minLength: 1, maxLength: 128 }),
		timestamp: Type.String({ format: "date-time" }),
		runId: RunIdSchema,
		type: Type.String({ minLength: 1, maxLength: 128 }),
		data: Type.Unknown(),
	},
	{ additionalProperties: false },
);
export type JournalEvent = Static<typeof JournalEventSchema>;

export const RunSnapshotSchema = Type.Object(
	{
		schema: Type.Literal("pi-subagent-snapshot"),
		contractRevision: Type.Literal(CONTRACT_REVISION),
		runId: RunIdSchema,
		lastSequence: Type.Integer({ minimum: 0 }),
		state: Type.Unknown(),
	},
	{ additionalProperties: false },
);
export type RunSnapshot = Static<typeof RunSnapshotSchema>;

export class PersistenceCorruptionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PersistenceCorruptionError";
	}
}

async function syncDirectory(directory: string): Promise<void> {
	const handle = await open(directory, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function writeAtomic(filePath: string, value: unknown): Promise<void> {
	const content = `${JSON.stringify(value, null, 2)}\n`;
	if (Buffer.byteLength(content) > MAX_SNAPSHOT_BYTES) {
		throw new Error("run snapshot exceeds size limit");
	}
	const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
	const handle = await open(temporary, "wx", 0o600);
	try {
		await handle.writeFile(content, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	await rename(temporary, filePath);
	await syncDirectory(path.dirname(filePath));
}

async function repairTornTail(
	journalPath: string,
	content: string,
): Promise<void> {
	if (!content || content.endsWith("\n")) return;
	const completeContent = content.slice(0, content.lastIndexOf("\n") + 1);
	const handle = await open(journalPath, "r+");
	try {
		await handle.truncate(Buffer.byteLength(completeContent));
		await handle.sync();
	} finally {
		await handle.close();
	}
}

function parseJournal(content: string, runId: RunId): JournalEvent[] {
	const hasTerminalNewline = content.endsWith("\n");
	const lines = content.split("\n");
	if (hasTerminalNewline) lines.pop();
	else lines.pop();
	const events: JournalEvent[] = [];
	for (const [index, line] of lines.entries()) {
		if (!line) {
			throw new PersistenceCorruptionError(
				`empty interior journal record at line ${index + 1}`,
			);
		}
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			throw new PersistenceCorruptionError(
				`invalid interior journal record at line ${index + 1}`,
			);
		}
		if (!Value.Check(JournalEventSchema, value)) {
			throw new PersistenceCorruptionError(
				`invalid journal schema at line ${index + 1}`,
			);
		}
		const event = value as JournalEvent;
		if (event.runId !== runId || event.sequence !== events.length + 1) {
			throw new PersistenceCorruptionError(
				`journal identity or sequence mismatch at line ${index + 1}`,
			);
		}
		events.push(event);
	}
	return events;
}

export class RunJournal {
	readonly runId: RunId;
	readonly directory: string;
	readonly journalPath: string;
	readonly snapshotPath: string;
	private sequence: number;
	private appendTail = Promise.resolve();

	private constructor(directory: string, runId: RunId, sequence: number) {
		this.directory = directory;
		this.runId = runId;
		this.journalPath = path.join(directory, "events.jsonl");
		this.snapshotPath = path.join(directory, "run.json");
		this.sequence = sequence;
	}

	static async open(root: string, runId: RunId): Promise<RunJournal> {
		if (!Value.Check(RunIdSchema, runId)) throw new Error("invalid run ID");
		await mkdir(root, { recursive: true, mode: 0o700 });
		await chmod(root, 0o700);
		const directory = path.join(root, runId);
		await mkdir(directory, { recursive: true, mode: 0o700 });
		await chmod(directory, 0o700);
		const journalPath = path.join(directory, "events.jsonl");
		let events: JournalEvent[] = [];
		try {
			const journalStat = await stat(journalPath);
			if (journalStat.size > MAX_JOURNAL_BYTES) {
				throw new PersistenceCorruptionError("journal exceeds size limit");
			}
			const content = await readFile(journalPath, "utf8");
			events = parseJournal(content, runId);
			await repairTornTail(journalPath, content);
			await chmod(journalPath, 0o600);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		return new RunJournal(directory, runId, events.length);
	}

	append(type: string, data: unknown): Promise<JournalEvent> {
		const operation = this.appendTail.then(async () => {
			const event: JournalEvent = {
				schema: "pi-subagent-event",
				contractRevision: CONTRACT_REVISION,
				sequence: this.sequence + 1,
				eventId: randomUUID(),
				timestamp: new Date().toISOString(),
				runId: this.runId,
				type,
				data,
			};
			if (!Value.Check(JournalEventSchema, event)) {
				throw new Error("invalid journal event");
			}
			let line: string;
			try {
				line = `${JSON.stringify(event)}\n`;
				if (!Value.Check(JournalEventSchema, JSON.parse(line))) {
					throw new Error("event is not JSON-roundtrip safe");
				}
			} catch (error) {
				throw new Error("journal event is not serializable", { cause: error });
			}
			const lineBytes = Buffer.byteLength(line);
			if (lineBytes > MAX_EVENT_BYTES) {
				throw new Error("journal event exceeds size limit");
			}
			try {
				const current = await stat(this.journalPath);
				if (current.size + lineBytes > MAX_JOURNAL_BYTES) {
					throw new Error("journal exceeds size limit");
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			const handle = await open(this.journalPath, "a", 0o600);
			try {
				await handle.writeFile(line, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
			this.sequence = event.sequence;
			return event;
		});
		this.appendTail = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}

	async readEvents(): Promise<JournalEvent[]> {
		await this.appendTail;
		try {
			return parseJournal(await readFile(this.journalPath, "utf8"), this.runId);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
	}

	async writeSnapshot(state: unknown): Promise<RunSnapshot> {
		await this.appendTail;
		const snapshot: RunSnapshot = {
			schema: "pi-subagent-snapshot",
			contractRevision: CONTRACT_REVISION,
			runId: this.runId,
			lastSequence: this.sequence,
			state,
		};
		if (!Value.Check(RunSnapshotSchema, snapshot)) {
			throw new Error("invalid run snapshot");
		}
		try {
			if (
				!Value.Check(RunSnapshotSchema, JSON.parse(JSON.stringify(snapshot)))
			) {
				throw new Error("snapshot is not JSON-roundtrip safe");
			}
		} catch (error) {
			throw new Error("run snapshot is not serializable", { cause: error });
		}
		await writeAtomic(this.snapshotPath, snapshot);
		return snapshot;
	}

	async readSnapshot(): Promise<RunSnapshot | undefined> {
		try {
			const value = JSON.parse(await readFile(this.snapshotPath, "utf8"));
			if (!Value.Check(RunSnapshotSchema, value)) {
				throw new PersistenceCorruptionError("invalid snapshot schema");
			}
			const snapshot = value as RunSnapshot;
			if (
				snapshot.runId !== this.runId ||
				snapshot.lastSequence > this.sequence
			) {
				throw new PersistenceCorruptionError(
					"snapshot identity or sequence mismatch",
				);
			}
			return snapshot;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			if (error instanceof PersistenceCorruptionError) throw error;
			throw new PersistenceCorruptionError("invalid snapshot JSON");
		}
	}
}
