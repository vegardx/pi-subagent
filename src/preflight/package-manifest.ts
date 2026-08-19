import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { CONTRACT_REVISION } from "../contracts.js";
import type { AgentSource } from "./agents.js";
import { digestFileResource, type ResourceDigest } from "./resources.js";

export const PackageAgentManifestSchema = Type.Object(
	{
		schema: Type.Literal("pi-subagent-package"),
		contractRevision: Type.Literal(CONTRACT_REVISION),
		agentDirectories: Type.Array(
			Type.String({ minLength: 1, maxLength: 1024 }),
			{ minItems: 1, maxItems: 16, uniqueItems: true },
		),
	},
	{ additionalProperties: false },
);
export type PackageAgentManifest = Static<typeof PackageAgentManifestSchema>;

export type PackageAgentSources = {
	manifest: ResourceDigest;
	sources: AgentSource[];
};

export class PackageAgentManifestError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "PackageAgentManifestError";
	}
}

function isInside(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return (
		relative === "" ||
		(relative !== ".." &&
			!relative.startsWith(`..${path.sep}`) &&
			!path.isAbsolute(relative))
	);
}

export async function discoverPackageAgentSources(
	manifestPath: string,
): Promise<PackageAgentSources> {
	if ((await lstat(manifestPath)).isSymbolicLink()) {
		throw new PackageAgentManifestError(
			"package agent manifest symlink denied",
		);
	}
	const manifest = await digestFileResource(manifestPath, {
		maxFiles: 1,
		maxBytes: 256 * 1024,
	});
	let value: unknown;
	try {
		value = JSON.parse(await readFile(manifest.canonicalPath, "utf8"));
	} catch (error) {
		throw new PackageAgentManifestError("invalid package agent manifest JSON", {
			cause: error,
		});
	}
	if (!Value.Check(PackageAgentManifestSchema, value)) {
		throw new PackageAgentManifestError(
			"invalid package agent manifest schema",
		);
	}
	const parsed = value as PackageAgentManifest;
	const packageRoot = path.dirname(manifest.canonicalPath);
	const sources: AgentSource[] = [];
	const canonicalDirectories = new Set<string>();
	for (const configuredPath of parsed.agentDirectories) {
		if (path.isAbsolute(configuredPath)) {
			throw new PackageAgentManifestError(
				"package agent directory must be relative",
			);
		}
		let directory: string;
		try {
			directory = await realpath(path.resolve(packageRoot, configuredPath));
		} catch (error) {
			throw new PackageAgentManifestError(
				`package agent directory unavailable: ${configuredPath}`,
				{ cause: error },
			);
		}
		if (!isInside(packageRoot, directory)) {
			throw new PackageAgentManifestError(
				`package agent directory escapes package: ${configuredPath}`,
			);
		}
		if (!(await lstat(directory)).isDirectory()) {
			throw new PackageAgentManifestError(
				`package agent source is not a directory: ${configuredPath}`,
			);
		}
		if (canonicalDirectories.has(directory)) {
			throw new PackageAgentManifestError(
				`duplicate canonical package agent directory: ${configuredPath}`,
			);
		}
		canonicalDirectories.add(directory);
		sources.push({ scope: "package", directory, trusted: true });
	}
	return { manifest, sources };
}
