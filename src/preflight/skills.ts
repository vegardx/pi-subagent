import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import {
	DefaultResourceLoader,
	SettingsManager,
	type Skill,
} from "@earendil-works/pi-coding-agent";
import { digestTreeResource } from "./resources.js";

const MAX_PRELOAD_BYTES = 256 * 1024;

export type ProjectedSkill = {
	name: string;
	description: string;
	hostBaseDir: string;
	hostFilePath: string;
	guestBaseDir: string;
	guestFilePath: string;
	sha256: string;
	skill: Skill;
};

export type SkillProjection = {
	catalog: ProjectedSkill[];
	preloadPrompt: string;
};

export class SkillProjectionError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "SkillProjectionError";
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

export async function discoverAndProjectSkills(options: {
	cwd: string;
	agentDir: string;
	projectTrusted: boolean;
	preloadSkills: string[];
}): Promise<SkillProjection> {
	const settingsManager = SettingsManager.create(options.cwd, options.agentDir);
	const loader = new DefaultResourceLoader({
		cwd: options.cwd,
		agentDir: options.agentDir,
		settingsManager,
		noExtensions: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await loader.reload({
		resolveProjectTrust: async () => options.projectTrusted,
	});
	const discovered = loader.getSkills().skills;
	const catalog: ProjectedSkill[] = [];
	const names = new Set<string>();
	for (const skill of discovered) {
		if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(skill.name)) {
			throw new SkillProjectionError(
				`invalid discovered skill name: ${skill.name}`,
			);
		}
		if (names.has(skill.name)) {
			throw new SkillProjectionError(
				`duplicate discovered skill: ${skill.name}`,
			);
		}
		names.add(skill.name);
		const hostBaseDir = await realpath(skill.baseDir);
		const hostFilePath = await realpath(skill.filePath);
		if (!isInside(hostBaseDir, hostFilePath)) {
			throw new SkillProjectionError(
				`skill file escapes base directory: ${skill.name}`,
			);
		}
		const digest = await digestTreeResource(hostBaseDir);
		const guestBaseDir = `/skills/${digest.sha256.slice(0, 16)}/${skill.name}`;
		const relativeFile = path.relative(hostBaseDir, hostFilePath);
		const guestFilePath = path.posix.join(
			guestBaseDir,
			relativeFile.split(path.sep).join(path.posix.sep),
		);
		catalog.push({
			name: skill.name,
			description: skill.description,
			hostBaseDir,
			hostFilePath,
			guestBaseDir,
			guestFilePath,
			sha256: digest.sha256,
			skill: {
				...skill,
				filePath: guestFilePath,
				baseDir: guestBaseDir,
			},
		});
	}
	catalog.sort((left, right) =>
		left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
	);
	const byName = new Map(catalog.map((skill) => [skill.name, skill]));
	let preloadBytes = 0;
	const preloadSections: string[] = [];
	for (const name of [...new Set(options.preloadSkills)]) {
		const skill = byName.get(name);
		if (!skill)
			throw new SkillProjectionError(`preload skill not found: ${name}`);
		const content = await readFile(skill.hostFilePath, "utf8");
		preloadBytes += Buffer.byteLength(content);
		if (preloadBytes > MAX_PRELOAD_BYTES) {
			throw new SkillProjectionError("preloaded skills exceed byte limit");
		}
		preloadSections.push(
			`<preloaded_skill name=${JSON.stringify(name)} path=${JSON.stringify(skill.guestFilePath)}>\n${content}\n</preloaded_skill>`,
		);
	}
	return {
		catalog,
		preloadPrompt: preloadSections.join("\n\n"),
	};
}
