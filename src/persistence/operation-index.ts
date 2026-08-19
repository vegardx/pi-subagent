import { createHash, randomUUID } from "node:crypto";
import {
	chmod,
	link,
	mkdir,
	open,
	readFile,
	realpath,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { CONTRACT_REVISION, type RunId, RunIdSchema } from "../contracts.js";
import { PersistenceCorruptionError } from "./journal.js";

const MAX_RECORD_BYTES = 16 * 1024;
const IdentitySchema = Type.String({ minLength: 1, maxLength: 256 });
const Sha256Schema = Type.String({ pattern: "^[a-f0-9]{64}$" });

export const OperationRecordSchema = Type.Object(
	{
		schema: Type.Literal("pi-subagent-operation"),
		contractRevision: Type.Literal(CONTRACT_REVISION),
		ownerId: IdentitySchema,
		operationId: IdentitySchema,
		requestSha256: Sha256Schema,
		runId: RunIdSchema,
		createdAt: Type.String({ format: "date-time" }),
	},
	{ additionalProperties: false },
);
export type OperationRecord = Static<typeof OperationRecordSchema>;

export class OperationConflictError extends Error {
	readonly existing: OperationRecord;

	constructor(existing: OperationRecord) {
		super("operation ID already belongs to a different request");
		this.name = "OperationConflictError";
		this.existing = existing;
	}
}

function recordKey(ownerId: string, operationId: string): string {
	return createHash("sha256")
		.update(ownerId)
		.update("\0")
		.update(operationId)
		.digest("hex");
}

async function readRecord(filePath: string): Promise<OperationRecord> {
	const metadata = await stat(filePath);
	if (metadata.size > MAX_RECORD_BYTES) {
		throw new PersistenceCorruptionError("operation record exceeds size limit");
	}
	let value: unknown;
	try {
		value = JSON.parse(await readFile(filePath, "utf8"));
	} catch {
		throw new PersistenceCorruptionError("invalid operation record JSON");
	}
	if (!Value.Check(OperationRecordSchema, value)) {
		throw new PersistenceCorruptionError("invalid operation record schema");
	}
	return value as OperationRecord;
}

async function syncDirectory(directory: string): Promise<void> {
	const handle = await open(directory, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

export class OperationIndex {
	readonly root: string;

	private constructor(root: string) {
		this.root = root;
	}

	static async open(root: string): Promise<OperationIndex> {
		await mkdir(root, { recursive: true, mode: 0o700 });
		await chmod(root, 0o700);
		return new OperationIndex(await realpath(root));
	}

	async find(
		ownerId: string,
		operationId: string,
	): Promise<OperationRecord | undefined> {
		if (
			!Value.Check(IdentitySchema, ownerId) ||
			!Value.Check(IdentitySchema, operationId)
		) {
			throw new Error("invalid operation lookup");
		}
		try {
			const record = await readRecord(
				path.join(this.root, `${recordKey(ownerId, operationId)}.json`),
			);
			if (record.ownerId !== ownerId || record.operationId !== operationId) {
				throw new PersistenceCorruptionError("operation record key mismatch");
			}
			return record;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}

	async claim(input: {
		ownerId: string;
		operationId: string;
		requestSha256: string;
		runId: RunId;
	}): Promise<{ record: OperationRecord; created: boolean }> {
		const record: OperationRecord = {
			schema: "pi-subagent-operation",
			contractRevision: CONTRACT_REVISION,
			ownerId: input.ownerId,
			operationId: input.operationId,
			requestSha256: input.requestSha256,
			runId: input.runId,
			createdAt: new Date().toISOString(),
		};
		if (!Value.Check(OperationRecordSchema, record)) {
			throw new Error("invalid operation claim");
		}

		const filePath = path.join(
			this.root,
			`${recordKey(input.ownerId, input.operationId)}.json`,
		);
		const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
		const content = `${JSON.stringify(record, null, 2)}\n`;
		await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
		const handle = await open(temporary, "r");
		try {
			await handle.sync();
		} finally {
			await handle.close();
		}

		let created = false;
		try {
			await link(temporary, filePath);
			created = true;
			await syncDirectory(this.root);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		} finally {
			await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
			});
		}

		if (created) return { record, created: true };
		const existing = await readRecord(filePath);
		if (
			existing.ownerId !== input.ownerId ||
			existing.operationId !== input.operationId
		) {
			throw new PersistenceCorruptionError("operation record key mismatch");
		}
		if (
			existing.requestSha256 !== input.requestSha256 ||
			existing.runId !== input.runId
		) {
			throw new OperationConflictError(existing);
		}
		return { record: existing, created: false };
	}
}
