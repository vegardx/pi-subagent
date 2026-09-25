import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type {
	ExtensionAPI,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	ClassifiedFailureSchema,
	CONTRACT_REVISION,
	FailureCodeSchema,
	HANDOFF_EXPORT_MEDIA_TYPE,
	RunStatusSchema,
	SUBAGENT_RUNTIME_CONTRACT,
} from "../src/contracts.js";
import piSubagentExtension, {
	CONFIRMED_ACTIONS,
	DEFAULT_ATTEMPT_TIMEOUT_MS,
	MAX_CUMULATIVE_RUNTIME_MS,
	MUTATING_TOOLS,
	READ_ONLY_TOOLS,
	SUBAGENT_LIMIT_CEILING,
	TEXT_ACTIONS,
	THINKING_LEVELS,
} from "../src/extension.js";
import {
	DEFAULT_MAX_TASK_COST,
	DEFAULT_MEMORY_BYTES,
	MAX_MEMORY_BYTES,
	MEMORY_GRANULARITY_BYTES,
} from "../src/launch-contracts.js";
import { AgentFrontmatterSchema } from "../src/preflight/agents.js";
import { BUDGET_STEERING_STAGES } from "../src/runtime/budget.js";
import { HOST_TOOL_NAMES } from "../src/runtime/host-tools.js";
import { GUEST_CACHE_HOME } from "../src/sandbox/tools.js";
import {
	HANDOFF_EXPORT_STATUSES,
	IMPLEMENTED_TOOLS,
	RUN_ACTIONS,
} from "../src/service.js";
import { HANDOFF_REF_PREFIX } from "../src/workspace/worktree.js";

type UnionSchema = { anyOf?: { const?: unknown }[] };
type ObjectSchema = {
	properties?: Record<string, unknown>;
	required?: string[];
};

type CommandDefinition = {
	description: string;
	getArgumentCompletions?(
		prefix: string,
	): { value: string; label: string }[] | null;
};

const skillPath = new URL("../skills/subagents/SKILL.md", import.meta.url);
const skill = await readFile(skillPath, "utf8");
const skillBody = skill.slice(skill.indexOf("\n---\n", 4) + 5);
const flatSkill = skill.replace(/\s+/gu, " ");

async function readSource(): Promise<Map<string, string>> {
	const root = path.resolve(import.meta.dirname, "..", "src");
	const entries = await readdir(root, { recursive: true });
	const sources = new Map<string, string>();
	for (const entry of entries.sort()) {
		if (!entry.endsWith(".ts")) continue;
		sources.set(
			entry.split(path.sep).join("/"),
			await readFile(path.join(root, entry), "utf8"),
		);
	}
	return sources;
}

const sources = await readSource();
const flatSource = [...sources.values()].join("\n").replace(/\s+/gu, " ");

function literals(schema: unknown): string[] {
	const values = ((schema as UnionSchema).anyOf ?? [])
		.map((member) => member.const)
		.filter((value): value is string => typeof value === "string");
	expect(values.length).toBeGreaterThan(0);
	return values;
}

/** Builds a template-literal placeholder as it appears in the runtime source. */
function slot(expression: string): string {
	return `\${${expression}}`;
}

function backticked(text: string): string[] {
	return [...text.matchAll(/`([^`\n]+)`/gu)].map((match) => match[1] as string);
}

function capture(pattern: RegExp): string {
	const match = pattern.exec(skillBody);
	expect(
		match,
		`skill is missing the text matched by ${pattern.source}`,
	).not.toBeNull();
	return (match as RegExpExecArray)[1] as string;
}

function section(heading: string): string {
	const start = skillBody.indexOf(`\n## ${heading}\n`);
	expect(start, `missing section: ${heading}`).toBeGreaterThan(-1);
	const rest = skillBody.slice(start + heading.length + 5);
	const end = rest.indexOf("\n## ");
	return end < 0 ? rest : rest.slice(0, end);
}

function bullet(prefix: string): string {
	const body = section("The tool");
	const start = body.indexOf(`- **${prefix}`);
	expect(start, `missing bullet: ${prefix}`).toBeGreaterThan(-1);
	const rest = body.slice(start);
	const end = rest.indexOf("\n- **");
	return end < 0 ? rest : rest.slice(0, end);
}

function registeredSurface(): {
	tool: ToolDefinition;
	command: CommandDefinition;
	shortcuts: string[];
} {
	let tool: ToolDefinition | undefined;
	const commands = new Map<string, CommandDefinition>();
	const shortcuts: string[] = [];
	const api = {
		events: { on: () => () => {}, emit() {} },
		registerTool(definition: ToolDefinition) {
			tool = definition;
		},
		on() {},
		registerCommand(name: string, definition: CommandDefinition) {
			commands.set(name, definition);
		},
		registerShortcut(shortcut: string) {
			shortcuts.push(shortcut);
		},
	} as unknown as ExtensionAPI;
	piSubagentExtension(api);
	const command = commands.get("subagents");
	expect(tool).toBeDefined();
	expect(command).toBeDefined();
	return {
		tool: tool as ToolDefinition,
		command: command as CommandDefinition,
		shortcuts,
	};
}

const surface = registeredSurface();
const toolSchema = surface.tool.parameters as ObjectSchema;
const subcommands = (surface.command.getArgumentCompletions?.("") ?? []).map(
	(completion) => completion.value,
);

describe("operating skill frontmatter", () => {
	it("uses the package skill header convention", async () => {
		expect(skill.startsWith("---\nname: subagents\ndescription: ")).toBe(true);
		const frontmatter = skill.slice(4, skill.indexOf("\n---\n", 4));
		expect(
			frontmatter
				.split("\n")
				.filter((line) => /^[a-z]+:/u.test(line))
				.map((line) => line.split(":")[0]),
		).toEqual(["name", "description"]);
		const packageJson = JSON.parse(
			await readFile(new URL("../package.json", import.meta.url), "utf8"),
		) as { version: string };
		expect(flatSkill).toContain(
			`\`@vegardx/pi-subagent\` ${packageJson.version}, contract revision ${CONTRACT_REVISION}`,
		);
	});
});

describe("operating skill tool surface", () => {
	it("documents exactly the registered tool and its parameters", () => {
		expect(surface.tool.name).toBe("subagent");
		expect(flatSkill).toContain("One tool, `subagent`.");
		const rows = [
			...section("The tool").matchAll(/^\| `(\w+)` \| (.+) \|$/gmu),
		];
		const documented = rows.map((row) => row[1] as string);
		expect(documented.sort()).toEqual(
			Object.keys(toolSchema.properties ?? {}).sort(),
		);
		const required = rows
			.filter((row) => (row[2] as string).includes("**Required.**"))
			.map((row) => row[1] as string)
			.sort();
		expect(required).toEqual([...(toolSchema.required ?? [])].sort());
	});

	it("documents the parameter defaults the tool applies", () => {
		const rows = new Map(
			[
				...section("The tool").matchAll(/^\| `(\w+)` \| (.+) \| (.+) \|$/gmu),
			].map((row) => [row[1] as string, `${row[2]} ${row[3]}`]),
		);
		expect(backticked(rows.get("tools") ?? "")).toEqual([...READ_ONLY_TOOLS]);
		const thinking = backticked(rows.get("thinking") ?? "");
		expect(thinking.slice(0, THINKING_LEVELS.length)).toEqual([
			...THINKING_LEVELS,
		]);
		expect(thinking.at(-1)).toBe("medium");
		expect(rows.get("timeoutMs")).toContain(
			`Default \`${DEFAULT_ATTEMPT_TIMEOUT_MS}\``,
		);
		expect(MEMORY_GRANULARITY_BYTES).toBe(64 * 1024 * 1024);
		expect(DEFAULT_MEMORY_BYTES).toBe(512 * 1024 * 1024);
		expect(MAX_MEMORY_BYTES).toBe(4 * 1024 * 1024 * 1024);
		const memory = rows.get("memoryBytes") ?? "";
		expect(memory).toContain(
			`${MEMORY_GRANULARITY_BYTES}..${MAX_MEMORY_BYTES}`,
		);
		expect(memory).toContain(`Default \`${DEFAULT_MEMORY_BYTES}\``);
		expect(memory).toContain(`max \`${MAX_MEMORY_BYTES}\``);
		expect(flatSkill).toContain("64 MiB steps");
		expect(MAX_CUMULATIVE_RUNTIME_MS).toBe(60 * 60 * 1000);
		expect(flatSkill).toContain(
			"the smaller of one hour and `timeoutMs` times three",
		);
	});

	it("names every tool the runtime can actually grant, and no others", () => {
		const granted = backticked(bullet("Only nine tool names ever work")).filter(
			(token) => /^[a-z]+$/u.test(token),
		);
		expect(granted).toEqual([...IMPLEMENTED_TOOLS, ...HOST_TOOL_NAMES]);
		expect(granted).toHaveLength(9);
	});

	it("rejects parameters the tool does not declare", () => {
		for (const name of backticked(bullet("There is no"))) {
			expect(Object.keys(toolSchema.properties ?? {})).not.toContain(name);
		}
	});
});

describe("operating skill workspace and handoff facts", () => {
	it("names the tools that promote a run to a worktree", () => {
		const promoting = backticked(
			capture(/selected automatically the moment ([\s\S]*?)\. The run gets/u),
		).filter((token) => IMPLEMENTED_TOOLS.has(token));
		expect(new Set(promoting)).toEqual(MUTATING_TOOLS);
	});

	it("pins the handoff reference, media type, and export statuses", () => {
		expect(skillBody).toContain(`${HANDOFF_REF_PREFIX}<runId>/<attemptId>`);
		expect(skillBody).toContain(HANDOFF_EXPORT_MEDIA_TYPE);
		expect(
			backticked(capture(/only while the run is ([\s\S]*?)\. Applying/u)),
		).toEqual([...HANDOFF_EXPORT_STATUSES]);
	});
});

describe("operating skill command surface", () => {
	it("uses only subcommands the extension registers", () => {
		const used = new Set(
			[...skillBody.matchAll(/\/subagents (?:\[?)([a-z-]+)/gu)].map(
				(match) => match[1] as string,
			),
		);
		expect(used.size).toBeGreaterThan(0);
		for (const token of used) expect(subcommands).toContain(token);
		for (const subcommand of subcommands) {
			expect(
				used.has(subcommand) || skillBody.includes(`\`${subcommand}\``),
				`skill never mentions /subagents ${subcommand}`,
			).toBe(true);
		}
		expect(surface.shortcuts).toEqual(["alt+s"]);
		expect(skillBody).toContain("alt+s");
	});

	it("lists the run actions and their argument rules", () => {
		expect(backticked(capture(/\nActions: ([\s\S]*?)\. Only/u))).toEqual([
			...RUN_ACTIONS,
		]);
		expect(backticked(capture(/Only ([^.]*?) accept trailing text/u))).toEqual([
			...TEXT_ACTIONS,
		]);
		expect(
			backticked(
				capture(
					/accept trailing text\. ([\s\S]*?) ask the operator to confirm/u,
				),
			),
		).toEqual([...CONFIRMED_ACTIONS]);
	});
});

describe("operating skill status and failure vocabulary", () => {
	it("lists every run status", () => {
		expect(backticked(capture(/Run statuses: ([\s\S]*?)\. Only/u))).toEqual(
			literals(RunStatusSchema),
		);
	});

	it("lists every retry class", () => {
		const table = section("Budgets and failure classes");
		const classes = [...table.matchAll(/^\| `([a-z]+)` \| /gmu)].map(
			(row) => row[1] as string,
		);
		expect(classes.sort()).toEqual(
			literals(
				(ClassifiedFailureSchema as ObjectSchema).properties?.retry,
			).sort(),
		);
	});

	it("separates emitted failure codes from declared-but-unused ones", () => {
		const declared = new Set(literals(FailureCodeSchema));
		const emitted = new Set<string>();
		for (const [file, source] of sources) {
			for (const match of source.matchAll(/code: "([a-z-]+)"/gu)) {
				if (declared.has(match[1] as string)) emitted.add(match[1] as string);
			}
			if (file !== "runtime/failure.ts") continue;
			for (const match of source.matchAll(/\bfailure\(\s*"([a-z-]+)"/gu)) {
				if (declared.has(match[1] as string)) emitted.add(match[1] as string);
			}
		}
		const documented = backticked(
			capture(/paraphrase: ([\s\S]*?)\. The contract also declares/u),
		);
		expect(documented).toEqual([...emitted].sort());
		const reserved = backticked(
			capture(/The contract also declares ?([\s\S]*?), which no/u),
		);
		expect(reserved.sort()).toEqual(
			[...declared].filter((code) => !emitted.has(code)).sort(),
		);
	});
});

describe("operating skill budgets, isolation, and evidence", () => {
	it("states the ceilings the tool grants", () => {
		expect(SUBAGENT_LIMIT_CEILING).toEqual({
			totalTokens: 10_000_000,
			cost: DEFAULT_MAX_TASK_COST,
			outputBytes: 1024 * 1024,
			workspaceWriteBytes: 512 * 1024 * 1024,
			retries: 1,
			resumes: 1,
		});
		expect(flatSkill).toContain(
			"Per-call ceilings: 10 000 000 total tokens, $100 cost, 1 MiB of output, 512 MiB of workspace writes, one retry, one resume.",
		);
		for (const stage of BUDGET_STEERING_STAGES) {
			expect(flatSkill).toContain(`${stage * 100}%`);
		}
	});

	it("states the sandbox facts the runtime configures", () => {
		const extension = sources.get("extension.ts") ?? "";
		const gondolin = sources.get("sandbox/gondolin.ts") ?? "";
		expect(extension).toContain("maxSlots: 4");
		expect(extension).toContain('mode: "public-egress"');
		expect(extension).toContain("blockInternalRanges: true");
		expect(extension).toContain("allowWebSockets: false");
		expect(gondolin).toContain("guestMemorySize(options.memoryBytes)");
		expect(gondolin).toContain("const DEFAULT_CPUS = 1;");
		expect(gondolin).toContain("options.cpus ?? DEFAULT_CPUS");
		expect(GUEST_CACHE_HOME).toBe("/tmp/cache");
		expect(sources.get("sandbox/tools.ts")).toContain(
			"XDG_CACHE_HOME: GUEST_CACHE_HOME",
		);
		expect(sources.get("launch-contracts.ts")).toContain(
			'cwd: Type.Literal("/workspace")',
		);
		expect(flatSkill).toContain("512 MiB of memory, 1 CPU");
		expect(flatSkill).toContain("At most four VMs run concurrently");
		expect(flatSkill).toContain("`public-egress` with internal ranges blocked");
		expect(flatSkill).toContain("guest working directory `/workspace`");
		expect(flatSkill).toContain(
			`\`$XDG_CACHE_HOME\` is \`${GUEST_CACHE_HOME}\` in the guest`,
		);
	});

	it("states the contract features that bound delegation", () => {
		expect(SUBAGENT_RUNTIME_CONTRACT.features.background).toBe(false);
		expect(SUBAGENT_RUNTIME_CONTRACT.features.survivesSeatExit).toBe(false);
		expect(SUBAGENT_RUNTIME_CONTRACT.features.vmMemoryCeiling).toBe(true);
		expect(SUBAGENT_RUNTIME_CONTRACT.features.workspaceBudgetRefusal).toBe(
			true,
		);
		expect(SUBAGENT_RUNTIME_CONTRACT.features.delegationCeiling).toBe(true);
		expect(flatSkill).toContain("`background: false`");
		expect(flatSkill).toContain("`survivesSeatExit: false`");
		expect(flatSkill).toContain("`vmMemoryCeiling: true`");
		expect(flatSkill).toContain("`workspaceBudgetRefusal: true`");
		expect(flatSkill).toContain("`delegationCeiling: true`");
	});

	it("points at the real service state locations", () => {
		const extension = sources.get("extension.ts") ?? "";
		expect(extension).toContain(
			'path.join(getAgentDir(), "subagents", "service")',
		);
		expect(extension).toContain(
			'path.join(getAgentDir(), "subagents", "capacity")',
		);
		expect(skillBody).toContain("`<agentDir>/subagents/service/`");
		expect(skillBody).toContain("`<agentDir>/subagents/capacity/`");
	});
});

describe("operating skill agent definitions", () => {
	it("lists the frontmatter keys the loader requires", () => {
		const schema = AgentFrontmatterSchema as ObjectSchema;
		const documented = backticked(
			capture(/Required keys: ([\s\S]*?)\. `model` is an object/u),
		);
		expect(documented.sort()).toEqual([...(schema.required ?? [])].sort());
		expect(Object.keys(schema.properties ?? {})).toContain("allowedModels");
		expect(schema.required).not.toContain("allowedModels");
		expect(Object.keys(schema.properties ?? {})).toContain("memoryBytes");
		expect(schema.required).not.toContain("memoryBytes");
		expect(sources.get("preflight/agents.ts")).toContain(
			"frontmatter.memoryBytes ?? DEFAULT_MEMORY_BYTES",
		);
		expect(sources.get("preflight/agents.ts")).toContain("256 * 1024");
	});
});

describe("operating skill quoted runtime messages", () => {
	it("quotes only messages that exist in the runtime source", () => {
		const quotes = [...skillBody.matchAll(/"([^"]{8,})"/gu)].map((match) =>
			(match[1] as string).replace(/\s+/gu, " "),
		);
		expect(quotes.length).toBeGreaterThan(10);
		for (const quote of quotes) expect(flatSource).toContain(quote);
	});

	it("renders templated messages exactly as the runtime builds them", () => {
		const templates: [string, string][] = [
			[
				"tool implementation unavailable: <name>",
				`tool implementation unavailable: ${slot("tool")}`,
			],
			[
				"tool exceeds ceiling: <name>",
				`${slot("kind")} exceeds ceiling: ${slot("name")}`,
			],
			[
				"workspace mode exceeds host ceiling: <mode> (host allows <modes>)",
				`workspace mode exceeds host ceiling: ${slot("request.workspace.mode")} (host allows ${slot('[...modes].sort().join(", ")')})`,
			],
			[
				"tool exceeds host ceiling: <name>",
				`tool exceeds host ceiling: ${slot("name")}`,
			],
			[
				"model exceeds ceiling: <key>",
				`model exceeds ceiling: ${slot("modelKey(requestedModel)")}`,
			],
			["limit exceeds ceiling: <key>", `limit exceeds ceiling: ${slot("key")}`],
			[
				"<action> is unavailable while the run is <status>",
				`${slot("subcommand")} is unavailable while the run is ${slot("run.status")}`,
			],
		];
		for (const [documented, source] of templates) {
			expect(skillBody).toContain(`\`${documented}\``);
			expect(flatSource).toContain(source);
		}
		expect(sources.get("preflight/compile.ts")).toContain(
			'assertSubset("tool"',
		);
	});
});
