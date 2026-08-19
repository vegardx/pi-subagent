import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { loadProjectContextFiles } from "@earendil-works/pi-coding-agent";
import type {
	AgentLaunchPlan,
	ContextScope,
	ResourceGrant,
} from "../launch-contracts.js";
import { canonicalSha256 } from "./canonical.js";
import { digestFileResource } from "./resources.js";

const MAX_CONTEXT_FILES = 16;
const MAX_CONTEXT_FILE_BYTES = 256 * 1024;
const MAX_CONTEXT_TOTAL_BYTES = 512 * 1024;

export type ProjectedContextFile = {
	scope: ContextScope;
	hostFilePath: string;
	guestFilePath: string;
	content: string;
	grant: ResourceGrant;
};

export type ContextFileProjection = {
	files: ProjectedContextFile[];
};

export class ContextFileProjectionError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "ContextFileProjectionError";
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

export async function discoverAndProjectContextFiles(options: {
	cwd: string;
	workspaceRoot: string;
	agentDir: string;
	projectTrusted: boolean;
	scopes: ContextScope[];
}): Promise<ContextFileProjection> {
	const scopes = new Set(options.scopes);
	if (scopes.size === 0) return { files: [] };
	if (scopes.has("project") && !options.projectTrusted) {
		throw new ContextFileProjectionError(
			"project context requires a trusted project",
		);
	}
	const canonicalAgentDir = await realpath(options.agentDir);
	const canonicalWorkspaceRoot = await realpath(options.workspaceRoot);
	const discovered = loadProjectContextFiles({
		cwd: options.cwd,
		agentDir: options.agentDir,
	});
	const selected: Array<{
		scope: ContextScope;
		path: string;
	}> = [];
	for (const contextFile of discovered) {
		const sourcePath = path.resolve(contextFile.path);
		const sourceDir = await realpath(path.dirname(sourcePath));
		const logicalSourcePath = path.join(sourceDir, path.basename(sourcePath));
		const scope: ContextScope =
			sourceDir === canonicalAgentDir ? "global" : "project";
		const metadata = await lstat(sourcePath);
		const canonicalPath = await realpath(sourcePath);
		if (
			scope === "project" &&
			isInside(canonicalWorkspaceRoot, logicalSourcePath) &&
			(metadata.isSymbolicLink() ||
				!isInside(canonicalWorkspaceRoot, canonicalPath))
		) {
			throw new ContextFileProjectionError(
				`repository context file cannot escape through a symlink: ${sourcePath}`,
			);
		}
		if (scopes.has(scope)) selected.push({ scope, path: canonicalPath });
	}
	if (selected.length > MAX_CONTEXT_FILES) {
		throw new ContextFileProjectionError("context file count exceeds limit");
	}
	let totalBytes = 0;
	const files: ProjectedContextFile[] = [];
	for (const [index, selectedFile] of selected.entries()) {
		const digest = await digestFileResource(selectedFile.path, {
			maxFiles: 1,
			maxBytes: MAX_CONTEXT_FILE_BYTES,
		});
		const bytes = await readFile(digest.canonicalPath);
		let content: string;
		try {
			content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch (error) {
			throw new ContextFileProjectionError(
				`context file is not valid UTF-8: ${digest.canonicalPath}`,
				{ cause: error },
			);
		}
		totalBytes += bytes.byteLength;
		if (totalBytes > MAX_CONTEXT_TOTAL_BYTES) {
			throw new ContextFileProjectionError(
				"context files exceed total byte limit",
			);
		}
		const name = `${selectedFile.scope}-${index}-${digest.sha256.slice(0, 12)}`;
		files.push({
			scope: selectedFile.scope,
			hostFilePath: digest.canonicalPath,
			guestFilePath: `/context/${name}/${path.basename(digest.canonicalPath)}`,
			content,
			grant: {
				kind: "context",
				name,
				source: digest.canonicalPath,
				sha256: digest.sha256,
			},
		});
	}
	return { files };
}

export function assertContextFileProjection(
	plan: AgentLaunchPlan,
	projection: ContextFileProjection,
): void {
	const expected = plan.resources
		.filter((resource) => resource.kind === "context")
		.map((resource) => resource)
		.sort((left, right) => left.name.localeCompare(right.name));
	const actual = projection.files
		.map((file) => file.grant)
		.sort((left, right) => left.name.localeCompare(right.name));
	if (canonicalSha256(expected) !== canonicalSha256(actual)) {
		throw new ContextFileProjectionError(
			"context file projection changed after preflight",
		);
	}
}
