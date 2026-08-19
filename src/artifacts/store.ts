import { createHash, randomUUID } from "node:crypto";
import {
	chmod,
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	realpath,
	rename,
	stat,
} from "node:fs/promises";
import path from "node:path";
import { Value } from "typebox/value";
import { type ArtifactRef, ArtifactRefSchema } from "../contracts.js";
import type { RunLease } from "../persistence/run-lease.js";

export type ArtifactExport = {
	ref: ArtifactRef;
	content: Buffer;
};

export class ArtifactStoreError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "ArtifactStoreError";
	}
}

function sha256(content: Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

async function syncDirectory(directory: string): Promise<void> {
	const handle = await open(directory, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

export class ArtifactStore {
	readonly root: string;
	readonly maxArtifactBytes: number;
	readonly maxTotalBytes: number;
	private readonly lease: RunLease;
	private mutationTail = Promise.resolve();

	private constructor(
		root: string,
		maxArtifactBytes: number,
		maxTotalBytes: number,
		lease: RunLease,
	) {
		this.root = root;
		this.maxArtifactBytes = maxArtifactBytes;
		this.maxTotalBytes = maxTotalBytes;
		this.lease = lease;
	}

	static async open(options: {
		root: string;
		maxArtifactBytes: number;
		maxTotalBytes: number;
		lease: RunLease;
	}): Promise<ArtifactStore> {
		for (const [name, value] of [
			["maxArtifactBytes", options.maxArtifactBytes],
			["maxTotalBytes", options.maxTotalBytes],
		] as const) {
			if (!Number.isSafeInteger(value) || value < 0) {
				throw new ArtifactStoreError(
					`${name} must be a non-negative safe integer`,
				);
			}
		}
		if (options.maxArtifactBytes > options.maxTotalBytes) {
			throw new ArtifactStoreError("artifact limit exceeds total limit");
		}
		await options.lease.assertCurrent();
		await mkdir(options.root, { recursive: true, mode: 0o700 });
		await chmod(options.root, 0o700);
		return new ArtifactStore(
			await realpath(options.root),
			options.maxArtifactBytes,
			options.maxTotalBytes,
			options.lease,
		);
	}

	private async totalBytes(): Promise<number> {
		let total = 0;
		for (const entry of await readdir(this.root)) {
			if (!entry.endsWith(".blob")) continue;
			const metadata = await lstat(path.join(this.root, entry));
			if (!metadata.isFile()) {
				throw new ArtifactStoreError(`invalid artifact entry: ${entry}`);
			}
			total += metadata.size;
			if (total > this.maxTotalBytes) {
				throw new ArtifactStoreError("artifact store exceeds total limit");
			}
		}
		return total;
	}

	put(content: Buffer | string, mediaType: string): Promise<ArtifactRef> {
		const input = Buffer.isBuffer(content)
			? Buffer.from(content)
			: Buffer.from(content, "utf8");
		const operation = this.mutationTail.then(async () => {
			await this.lease.assertCurrent();
			const bytes = input;
			if (bytes.byteLength > this.maxArtifactBytes) {
				throw new ArtifactStoreError("artifact exceeds byte limit");
			}
			const digest = sha256(bytes);
			const ref: ArtifactRef = {
				id: `artifact_${digest}`,
				sha256: digest,
				bytes: bytes.byteLength,
				mediaType,
			};
			if (!Value.Check(ArtifactRefSchema, ref)) {
				throw new ArtifactStoreError("invalid artifact metadata");
			}
			const target = path.join(this.root, `${digest}.blob`);
			try {
				const existing = await stat(target);
				if (existing.size !== bytes.byteLength) {
					throw new ArtifactStoreError("artifact digest collision");
				}
				if (sha256(await readFile(target)) !== digest) {
					throw new ArtifactStoreError("existing artifact digest mismatch");
				}
				return ref;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			if ((await this.totalBytes()) + bytes.byteLength > this.maxTotalBytes) {
				throw new ArtifactStoreError("artifact store total limit exceeded");
			}
			const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
			const handle = await open(temporary, "wx", 0o600);
			try {
				await handle.writeFile(bytes);
				await handle.sync();
			} finally {
				await handle.close();
			}
			await this.lease.assertCurrent();
			await rename(temporary, target);
			await syncDirectory(this.root);
			return ref;
		});
		this.mutationTail = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}

	async export(
		ref: ArtifactRef,
		maxBytes = this.maxArtifactBytes,
	): Promise<ArtifactExport> {
		if (!Value.Check(ArtifactRefSchema, ref)) {
			throw new ArtifactStoreError("invalid artifact reference");
		}
		if (
			!Number.isSafeInteger(maxBytes) ||
			maxBytes < 0 ||
			ref.bytes > maxBytes
		) {
			throw new ArtifactStoreError("artifact export exceeds byte limit");
		}
		const filePath = path.join(this.root, `${ref.sha256}.blob`);
		const metadata = await lstat(filePath);
		if (!metadata.isFile() || metadata.size !== ref.bytes) {
			throw new ArtifactStoreError("artifact size mismatch");
		}
		const content = await readFile(filePath);
		if (sha256(content) !== ref.sha256) {
			throw new ArtifactStoreError("artifact digest mismatch");
		}
		return { ref: { ...ref }, content };
	}
}
