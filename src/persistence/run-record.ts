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
import { CONTRACT_REVISION, RunIdSchema } from "../contracts.js";
import {
	type AgentLaunchPlan,
	AgentLaunchPlanSchema,
} from "../launch-contracts.js";
import { verifyLaunchPlanIdentity } from "../preflight/compile.js";
import { PersistenceCorruptionError } from "./journal.js";

const MAX_RUN_RECORD_BYTES = 1024 * 1024;

export const RunRecordSchema = Type.Object(
	{
		schema: Type.Literal("pi-subagent-run-record"),
		contractRevision: Type.Literal(CONTRACT_REVISION),
		ownerId: Type.String({ minLength: 1, maxLength: 256 }),
		plan: AgentLaunchPlanSchema,
		createdAt: Type.String({ format: "date-time" }),
	},
	{ additionalProperties: false },
);
export type RunRecord = Static<typeof RunRecordSchema>;

async function syncDirectory(directory: string): Promise<void> {
	const handle = await open(directory, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

export class RunRecordStore {
	readonly root: string;

	private constructor(root: string) {
		this.root = root;
	}

	static async open(root: string): Promise<RunRecordStore> {
		await mkdir(root, { recursive: true, mode: 0o700 });
		await chmod(root, 0o700);
		return new RunRecordStore(await realpath(root));
	}

	private filePath(runId: string): string {
		if (!Value.Check(RunIdSchema, runId)) throw new Error("invalid run ID");
		return path.join(this.root, `${runId}.json`);
	}

	async create(ownerId: string, plan: AgentLaunchPlan): Promise<RunRecord> {
		if (ownerId !== plan.ownerId || !verifyLaunchPlanIdentity(plan)) {
			throw new Error("invalid run record identity");
		}
		const record: RunRecord = {
			schema: "pi-subagent-run-record",
			contractRevision: CONTRACT_REVISION,
			ownerId,
			plan,
			createdAt: new Date().toISOString(),
		};
		if (!Value.Check(RunRecordSchema, record)) {
			throw new Error("invalid run record");
		}
		const content = `${JSON.stringify(record)}\n`;
		if (Buffer.byteLength(content) > MAX_RUN_RECORD_BYTES) {
			throw new Error("run record exceeds byte limit");
		}
		const target = this.filePath(plan.runId);
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
			await link(temporary, target);
			created = true;
			await syncDirectory(this.root);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		} finally {
			await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
			});
		}
		if (created) return record;
		const existing = await this.read(plan.runId);
		if (
			existing.ownerId !== ownerId ||
			existing.plan.identitySha256 !== plan.identitySha256
		) {
			throw new Error("run record conflicts with existing identity");
		}
		return existing;
	}

	async read(runId: string): Promise<RunRecord> {
		const filePath = this.filePath(runId);
		const metadata = await stat(filePath);
		if (!metadata.isFile() || metadata.size > MAX_RUN_RECORD_BYTES) {
			throw new PersistenceCorruptionError("invalid run record file");
		}
		let value: unknown;
		try {
			value = JSON.parse(await readFile(filePath, "utf8"));
		} catch {
			throw new PersistenceCorruptionError("invalid run record JSON");
		}
		if (!Value.Check(RunRecordSchema, value)) {
			throw new PersistenceCorruptionError("invalid run record schema");
		}
		const record = value as RunRecord;
		if (
			record.plan.runId !== runId ||
			record.ownerId !== record.plan.ownerId ||
			!verifyLaunchPlanIdentity(record.plan)
		) {
			throw new PersistenceCorruptionError("run record identity mismatch");
		}
		return record;
	}

	async list(): Promise<RunRecord[]> {
		const records: RunRecord[] = [];
		for (const entry of (await readdir(this.root)).sort()) {
			if (!entry.endsWith(".json")) continue;
			records.push(await this.read(entry.slice(0, -5)));
		}
		return records;
	}
}
