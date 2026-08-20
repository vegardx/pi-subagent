import { createHash, randomUUID } from "node:crypto";
import {
	chmod,
	mkdir,
	open,
	readFile,
	realpath,
	rename,
	stat,
} from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import {
	assertContractRevision,
	CONTRACT_REVISION,
	IncompatibleContractRevisionError,
	type RunId,
	RunIdSchema,
} from "../contracts.js";
import { PersistenceCorruptionError } from "./journal.js";

const MAX_RECORD_BYTES = 16 * 1024;

export const RunLeaseRecordSchema = Type.Object(
	{
		schema: Type.Literal("pi-subagent-run-lease"),
		contractRevision: Type.Literal(CONTRACT_REVISION),
		runId: RunIdSchema,
		leaseId: Type.String({ minLength: 1, maxLength: 128 }),
		generation: Type.Integer({ minimum: 1 }),
		pid: Type.Integer({ minimum: 1 }),
		processStartedAt: Type.Number({ minimum: 0 }),
		port: Type.Integer({ minimum: 1024, maximum: 65_535 }),
		acquiredAt: Type.String({ format: "date-time" }),
	},
	{ additionalProperties: false },
);
export type RunLeaseRecord = Static<typeof RunLeaseRecordSchema>;

export type RunLease = {
	record: RunLeaseRecord;
	assertCurrent(): Promise<void>;
	release(): Promise<void>;
};

export class RunLeaseUnavailableError extends Error {
	constructor(readonly runId: RunId) {
		super(`run lease unavailable: ${runId}`);
		this.name = "RunLeaseUnavailableError";
	}
}

export class RunLeaseFencedError extends Error {
	constructor(readonly runId: RunId) {
		super(`run lease fenced: ${runId}`);
		this.name = "RunLeaseFencedError";
	}
}

function leasePort(root: string, runId: RunId): number {
	const value = createHash("sha256")
		.update(root)
		.update("\0")
		.update(runId)
		.digest()
		.readUInt32BE(0);
	return 20_000 + (value % 20_000);
}

async function bind(port: number): Promise<net.Server | undefined> {
	const server = net.createServer((socket) => socket.destroy());
	try {
		await new Promise<void>((resolve, reject) => {
			const onError = (error: NodeJS.ErrnoException) => {
				server.off("listening", onListening);
				reject(error);
			};
			const onListening = () => {
				server.off("error", onError);
				resolve();
			};
			server.once("error", onError);
			server.once("listening", onListening);
			server.listen({ host: "127.0.0.1", port, exclusive: true });
		});
		server.on("error", () => {});
		server.unref();
		return server;
	} catch (error) {
		server.close();
		if ((error as NodeJS.ErrnoException).code === "EADDRINUSE")
			return undefined;
		throw error;
	}
}

async function close(server: net.Server): Promise<void> {
	if (!server.listening) return;
	await new Promise<void>((resolve, reject) =>
		server.close((error) => (error ? reject(error) : resolve())),
	);
}

async function syncDirectory(directory: string): Promise<void> {
	const handle = await open(directory, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function readRecord(
	filePath: string,
): Promise<RunLeaseRecord | undefined> {
	try {
		const metadata = await stat(filePath);
		if (metadata.size > MAX_RECORD_BYTES) {
			throw new PersistenceCorruptionError(
				"run lease record exceeds size limit",
			);
		}
		const value = JSON.parse(await readFile(filePath, "utf8")) as unknown;
		assertContractRevision(value, "run lease record");
		if (!Value.Check(RunLeaseRecordSchema, value)) {
			throw new PersistenceCorruptionError("invalid run lease record schema");
		}
		return value as RunLeaseRecord;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		if (
			error instanceof PersistenceCorruptionError ||
			error instanceof IncompatibleContractRevisionError
		) {
			throw error;
		}
		throw new PersistenceCorruptionError("invalid run lease record JSON");
	}
}

export async function acquireRunLease(options: {
	root: string;
	runId: RunId;
}): Promise<RunLease> {
	if (!Value.Check(RunIdSchema, options.runId))
		throw new Error("invalid run ID");
	await mkdir(options.root, { recursive: true, mode: 0o700 });
	await chmod(options.root, 0o700);
	const root = await realpath(options.root);
	const port = leasePort(root, options.runId);
	const server = await bind(port);
	if (!server) throw new RunLeaseUnavailableError(options.runId);
	const recordPath = path.join(root, `${options.runId}.lease.json`);
	try {
		const existing = await readRecord(recordPath);
		const record: RunLeaseRecord = {
			schema: "pi-subagent-run-lease",
			contractRevision: CONTRACT_REVISION,
			runId: options.runId,
			leaseId: randomUUID(),
			generation: (existing?.generation ?? 0) + 1,
			pid: process.pid,
			processStartedAt: performance.timeOrigin,
			port,
			acquiredAt: new Date().toISOString(),
		};
		const temporary = `${recordPath}.${process.pid}.${record.leaseId}.tmp`;
		const handle = await open(temporary, "wx", 0o600);
		try {
			await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temporary, recordPath);
		await syncDirectory(root);

		let releasePromise: Promise<void> | undefined;
		return {
			record,
			async assertCurrent() {
				const current = await readRecord(recordPath);
				if (
					!server.listening ||
					current?.leaseId !== record.leaseId ||
					current.generation !== record.generation
				) {
					throw new RunLeaseFencedError(options.runId);
				}
			},
			release() {
				releasePromise ??= close(server);
				return releasePromise;
			},
		};
	} catch (error) {
		await close(server);
		throw error;
	}
}
