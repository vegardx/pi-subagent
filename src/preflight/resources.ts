import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { canonicalSha256 } from "./canonical.js";

export type ResourceDigest = {
	canonicalPath: string;
	sha256: string;
	files: number;
	bytes: number;
};

export type ResourceDigestLimits = {
	maxFiles: number;
	maxBytes: number;
};

const DEFAULT_LIMITS: ResourceDigestLimits = {
	maxFiles: 10_000,
	maxBytes: 64 * 1024 * 1024,
};

export class ResourceDigestError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ResourceDigestError";
	}
}

function validateLimits(limits: ResourceDigestLimits): void {
	if (!Number.isSafeInteger(limits.maxFiles) || limits.maxFiles < 1) {
		throw new Error("maxFiles must be a positive safe integer");
	}
	if (!Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1) {
		throw new Error("maxBytes must be a positive safe integer");
	}
}

function contentSha256(content: Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

export async function digestFileResource(
	filePath: string,
	limits: ResourceDigestLimits = DEFAULT_LIMITS,
): Promise<ResourceDigest> {
	validateLimits(limits);
	const canonicalPath = await realpath(filePath);
	const metadata = await lstat(canonicalPath);
	if (!metadata.isFile())
		throw new ResourceDigestError("resource is not a file");
	if (metadata.size > limits.maxBytes) {
		throw new ResourceDigestError("resource exceeds byte limit");
	}
	const content = await readFile(canonicalPath);
	return {
		canonicalPath,
		sha256: contentSha256(content),
		files: 1,
		bytes: content.byteLength,
	};
}

type TreeEntry = {
	path: string;
	type: "directory" | "file";
	executable: boolean;
	bytes: number;
	sha256?: string;
};

export async function digestTreeResource(
	treePath: string,
	limits: ResourceDigestLimits = DEFAULT_LIMITS,
): Promise<ResourceDigest> {
	validateLimits(limits);
	const canonicalPath = await realpath(treePath);
	const rootMetadata = await lstat(canonicalPath);
	if (!rootMetadata.isDirectory()) {
		throw new ResourceDigestError("resource is not a directory");
	}
	const entries: TreeEntry[] = [];
	let files = 0;
	let bytes = 0;

	async function walk(directory: string, relativeDirectory: string) {
		const names = await readdir(directory);
		names.sort();
		for (const name of names) {
			const absolutePath = path.join(directory, name);
			const relativePath = relativeDirectory
				? path.posix.join(relativeDirectory, name)
				: name;
			const metadata = await lstat(absolutePath);
			if (metadata.isSymbolicLink()) {
				throw new ResourceDigestError(
					`resource symlink denied: ${relativePath}`,
				);
			}
			if (metadata.isDirectory()) {
				entries.push({
					path: relativePath,
					type: "directory",
					executable: false,
					bytes: 0,
				});
				await walk(absolutePath, relativePath);
				continue;
			}
			if (!metadata.isFile()) {
				throw new ResourceDigestError(
					`unsupported resource entry: ${relativePath}`,
				);
			}
			files++;
			if (files > limits.maxFiles) {
				throw new ResourceDigestError("resource exceeds file limit");
			}
			const content = await readFile(absolutePath);
			bytes += content.byteLength;
			if (bytes > limits.maxBytes) {
				throw new ResourceDigestError("resource exceeds byte limit");
			}
			entries.push({
				path: relativePath,
				type: "file",
				executable: (metadata.mode & 0o111) !== 0,
				bytes: content.byteLength,
				sha256: contentSha256(content),
			});
		}
	}

	await walk(canonicalPath, "");
	return {
		canonicalPath,
		sha256: canonicalSha256(entries),
		files,
		bytes,
	};
}
