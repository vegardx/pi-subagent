import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { parse } from "yaml";
import {
	ExactModelRequestSchema,
	RunLimitsSchema,
} from "../launch-contracts.js";
import type { AgentDefinition } from "./compile.js";
import { digestFileResource } from "./resources.js";

export type AgentSourceScope = "builtin" | "package" | "global" | "project";

export type AgentSource = {
	scope: AgentSourceScope;
	directory: string;
	trusted: boolean;
};

export type DiscoveredAgent = AgentDefinition & {
	prompt: string;
	scope: AgentSourceScope;
};

const ResourceNameSchema = Type.String({
	pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]*$",
	minLength: 1,
	maxLength: 128,
});
const ModelRouteSchema = Type.String({
	pattern: "^.+/.+:(off|minimal|low|medium|high|xhigh)$",
	maxLength: 512,
});

const FrontmatterSchema = Type.Object(
	{
		name: Type.String({
			pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]*$",
			maxLength: 128,
		}),
		model: ExactModelRequestSchema,
		allowedModels: Type.Optional(
			Type.Array(ModelRouteSchema, { maxItems: 64, uniqueItems: true }),
		),
		tools: Type.Array(ResourceNameSchema, {
			maxItems: 64,
			uniqueItems: true,
		}),
		skills: Type.Array(ResourceNameSchema, {
			maxItems: 64,
			uniqueItems: true,
		}),
		workspaceModes: Type.Array(
			Type.Union([Type.Literal("read-only"), Type.Literal("worktree")]),
			{ minItems: 1, maxItems: 2, uniqueItems: true },
		),
		limits: RunLimitsSchema,
	},
	{ additionalProperties: false },
);

const priorities: Record<AgentSourceScope, number> = {
	builtin: 0,
	package: 1,
	global: 2,
	project: 3,
};

export class AgentDiscoveryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AgentDiscoveryError";
	}
}

function splitFrontmatter(content: string): {
	metadata: unknown;
	prompt: string;
} {
	const normalized = content.replaceAll("\r\n", "\n");
	if (!normalized.startsWith("---\n")) {
		throw new AgentDiscoveryError("agent definition requires YAML frontmatter");
	}
	const end = normalized.indexOf("\n---\n", 4);
	if (end < 0)
		throw new AgentDiscoveryError("agent frontmatter is unterminated");
	let metadata: unknown;
	try {
		metadata = parse(normalized.slice(4, end));
	} catch (error) {
		throw new AgentDiscoveryError(`invalid agent YAML: ${String(error)}`);
	}
	const prompt = normalized.slice(end + 5).trim();
	if (!prompt) throw new AgentDiscoveryError("agent prompt is empty");
	if (Buffer.byteLength(prompt) > 256 * 1024) {
		throw new AgentDiscoveryError("agent prompt exceeds byte limit");
	}
	return { metadata, prompt };
}

async function loadAgent(
	filePath: string,
	scope: AgentSourceScope,
): Promise<DiscoveredAgent> {
	const content = await readFile(filePath, "utf8");
	const { metadata, prompt } = splitFrontmatter(content);
	if (!Value.Check(FrontmatterSchema, metadata)) {
		throw new AgentDiscoveryError(`invalid agent frontmatter: ${filePath}`);
	}
	const frontmatter = metadata as {
		name: string;
		model: DiscoveredAgent["defaultModel"];
		allowedModels?: string[];
		tools: string[];
		skills: string[];
		workspaceModes: DiscoveredAgent["workspaceModes"];
		limits: DiscoveredAgent["limitCeiling"];
	};
	if (path.basename(filePath, ".md") !== frontmatter.name) {
		throw new AgentDiscoveryError(
			`agent name does not match file: ${filePath}`,
		);
	}
	const digest = await digestFileResource(filePath);
	const exactModel = `${frontmatter.model.provider}/${frontmatter.model.id}:${frontmatter.model.thinking}`;
	const allowedModels = frontmatter.allowedModels ?? [exactModel];
	if (!allowedModels.includes(exactModel)) {
		throw new AgentDiscoveryError("default model exceeds agent model ceiling");
	}
	return {
		name: frontmatter.name,
		source: digest.canonicalPath,
		sha256: digest.sha256,
		defaultModel: frontmatter.model,
		allowedModels,
		tools: [...frontmatter.tools],
		skills: [...frontmatter.skills],
		workspaceModes: [...frontmatter.workspaceModes],
		limitCeiling: frontmatter.limits,
		prompt,
		scope,
	};
}

export async function discoverAgents(
	sources: AgentSource[],
): Promise<Map<string, DiscoveredAgent>> {
	const selected = new Map<string, DiscoveredAgent>();
	const identities = new Set<string>();
	for (const source of [...sources].sort(
		(left, right) => priorities[left.scope] - priorities[right.scope],
	)) {
		if (source.scope === "project" && !source.trusted) {
			throw new AgentDiscoveryError("project agent source is not trusted");
		}
		let entries: string[];
		try {
			entries = (await readdir(source.directory))
				.filter((name) => name.endsWith(".md"))
				.sort();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		for (const entry of entries) {
			const agent = await loadAgent(
				path.join(source.directory, entry),
				source.scope,
			);
			const identity = `${source.scope}:${agent.name}`;
			if (identities.has(identity)) {
				throw new AgentDiscoveryError(`duplicate agent in scope: ${identity}`);
			}
			identities.add(identity);
			selected.set(agent.name, agent);
		}
	}
	return selected;
}
