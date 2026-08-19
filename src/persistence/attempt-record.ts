import { randomUUID } from "node:crypto";
import {
	chmod,
	link,
	mkdir,
	open,
	readdir,
	readFile,
	realpath,
	stat,
	unlink,
} from "node:fs/promises";
import path from "node:path";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import {
	AttemptIdSchema,
	CONTRACT_REVISION,
	RunIdSchema,
} from "../contracts.js";
import {
	type AgentLaunchPlan,
	AgentLaunchPlanSchema,
} from "../launch-contracts.js";
import { verifyLaunchPlanIdentity } from "../preflight/compile.js";
import { PersistenceCorruptionError } from "./journal.js";
import type { RunLease } from "./run-lease.js";

const MAX_ATTEMPT_RECORD_BYTES = 1024 * 1024;
const attemptTails = new Map<string, Promise<void>>();

export const AttemptRecordSchema = Type.Object(
	{
		schema: Type.Literal("pi-subagent-attempt-record"),
		contractRevision: Type.Literal(CONTRACT_REVISION),
		ownerId: Type.String({ minLength: 1, maxLength: 256 }),
		runId: RunIdSchema,
		attemptId: AttemptIdSchema,
		ordinal: Type.Integer({ minimum: 0, maximum: 10_000 }),
		kind: Type.Union([
			Type.Literal("initial"),
			Type.Literal("retry"),
			Type.Literal("resume"),
		]),
		parentAttemptId: Type.Optional(AttemptIdSchema),
		worktreeAttemptId: Type.Optional(AttemptIdSchema),
		plan: AgentLaunchPlanSchema,
		createdAt: Type.String({ format: "date-time" }),
	},
	{ additionalProperties: false },
);
export type AttemptRecord = Static<typeof AttemptRecordSchema>;

async function syncDirectory(directory: string): Promise<void> {
	const handle = await open(directory, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

export class AttemptRecordStore {
	readonly root: string;

	private constructor(root: string) {
		this.root = root;
	}

	static async open(root: string): Promise<AttemptRecordStore> {
		await mkdir(root, { recursive: true, mode: 0o700 });
		await chmod(root, 0o700);
		return new AttemptRecordStore(await realpath(root));
	}

	private runDirectory(runId: string): string {
		if (!Value.Check(RunIdSchema, runId)) throw new Error("invalid run ID");
		return path.join(this.root, runId);
	}

	private async readPath(filePath: string): Promise<AttemptRecord> {
		const metadata = await stat(filePath);
		if (!metadata.isFile() || metadata.size > MAX_ATTEMPT_RECORD_BYTES) {
			throw new PersistenceCorruptionError("invalid attempt record file");
		}
		let value: unknown;
		try {
			value = JSON.parse(await readFile(filePath, "utf8"));
		} catch {
			throw new PersistenceCorruptionError("invalid attempt record JSON");
		}
		if (!Value.Check(AttemptRecordSchema, value)) {
			throw new PersistenceCorruptionError("invalid attempt record schema");
		}
		const record = value as AttemptRecord;
		if (
			record.plan.runId !== record.runId ||
			record.plan.attemptId !== record.attemptId ||
			record.plan.ownerId !== record.ownerId ||
			!verifyLaunchPlanIdentity(record.plan)
		) {
			throw new PersistenceCorruptionError("attempt record identity mismatch");
		}
		return record;
	}

	async create(input: {
		ownerId: string;
		plan: AgentLaunchPlan;
		lease: RunLease;
		ordinal: number;
		kind: AttemptRecord["kind"];
		parentAttemptId?: string;
		worktreeAttemptId?: string;
	}): Promise<AttemptRecord> {
		if (input.lease.record.runId !== input.plan.runId) {
			throw new Error("attempt record lease identity mismatch");
		}
		const tailKey = `${this.root}\0${input.plan.runId}`;
		const previous = attemptTails.get(tailKey) ?? Promise.resolve();
		let release = () => {};
		const current = new Promise<void>((resolve) => {
			release = resolve;
		});
		attemptTails.set(tailKey, current);
		await previous;
		try {
			await input.lease.assertCurrent();
			const record: AttemptRecord = {
				schema: "pi-subagent-attempt-record",
				contractRevision: CONTRACT_REVISION,
				ownerId: input.ownerId,
				runId: input.plan.runId,
				attemptId: input.plan.attemptId,
				ordinal: input.ordinal,
				kind: input.kind,
				...(input.parentAttemptId
					? { parentAttemptId: input.parentAttemptId }
					: {}),
				...(input.worktreeAttemptId
					? { worktreeAttemptId: input.worktreeAttemptId }
					: {}),
				plan: input.plan,
				createdAt: new Date().toISOString(),
			};
			if (
				!Value.Check(AttemptRecordSchema, record) ||
				!verifyLaunchPlanIdentity(input.plan)
			) {
				throw new Error("invalid attempt record");
			}
			const directory = this.runDirectory(record.runId);
			await mkdir(directory, { recursive: true, mode: 0o700 });
			await chmod(directory, 0o700);
			const target = path.join(directory, `${record.attemptId}.json`);
			try {
				const existing = await this.readPath(target);
				if (
					existing.ownerId !== record.ownerId ||
					existing.plan.identitySha256 !== record.plan.identitySha256 ||
					existing.ordinal !== record.ordinal ||
					existing.kind !== record.kind ||
					existing.worktreeAttemptId !== record.worktreeAttemptId
				) {
					throw new Error("attempt record conflicts with existing identity");
				}
				return existing;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			await input.lease.assertCurrent();
			const latest = await this.latest(record.runId);
			if (record.kind === "initial") {
				if (
					latest ||
					record.ordinal !== 0 ||
					record.parentAttemptId !== undefined
				) {
					throw new Error("invalid initial attempt lineage");
				}
			} else if (
				!latest ||
				record.ordinal !== latest.ordinal + 1 ||
				record.parentAttemptId !== latest.attemptId
			) {
				throw new Error("invalid attempt lineage");
			}
			const content = `${JSON.stringify(record)}\n`;
			if (Buffer.byteLength(content) > MAX_ATTEMPT_RECORD_BYTES) {
				throw new Error("attempt record exceeds byte limit");
			}
			const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
			const handle = await open(temporary, "wx", 0o600);
			try {
				await handle.writeFile(content, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
			let created = false;
			try {
				await input.lease.assertCurrent();
				await link(temporary, target);
				created = true;
				await syncDirectory(directory);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			} finally {
				await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
					if (error.code !== "ENOENT") throw error;
				});
			}
			if (created) return record;
			const existing = await this.readPath(target);
			if (
				existing.ownerId !== record.ownerId ||
				existing.plan.identitySha256 !== record.plan.identitySha256 ||
				existing.ordinal !== record.ordinal ||
				existing.kind !== record.kind ||
				existing.worktreeAttemptId !== record.worktreeAttemptId
			) {
				throw new Error("attempt record conflicts with existing identity");
			}
			return existing;
		} finally {
			release();
			if (attemptTails.get(tailKey) === current) {
				attemptTails.delete(tailKey);
			}
		}
	}

	async list(runId: string): Promise<AttemptRecord[]> {
		const directory = this.runDirectory(runId);
		let entries: string[];
		try {
			entries = await readdir(directory);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		const records: AttemptRecord[] = [];
		for (const entry of entries.sort()) {
			if (!entry.endsWith(".json")) continue;
			records.push(await this.readPath(path.join(directory, entry)));
		}
		return records.sort((left, right) => left.ordinal - right.ordinal);
	}

	async latest(runId: string): Promise<AttemptRecord | undefined> {
		return (await this.list(runId)).at(-1);
	}
}
