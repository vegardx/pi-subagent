import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	DefaultResourceLoader,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	discoverAndProjectSkills,
	SkillProjectionError,
} from "../src/preflight/skills.js";

function root(name: string): string {
	return path.join(tmpdir(), `pi-subagent-skills-${name}-${randomUUID()}`);
}

async function writeSkill(directory: string, name: string, body: string) {
	await mkdir(directory, { recursive: true });
	await writeFile(
		path.join(directory, "SKILL.md"),
		`---\nname: ${name}\ndescription: Use ${name} for qualification.\n---\n\n${body}\n`,
	);
	await mkdir(path.join(directory, "scripts"), { recursive: true });
	await writeFile(
		path.join(directory, "scripts", "check.sh"),
		"echo skill-ok\n",
	);
}

describe("normal Pi skill projection", () => {
	it("discovers global skills and force-preloads selected content", async () => {
		const base = root("global");
		const agentDir = path.join(base, "agent");
		const cwd = path.join(base, "project");
		await mkdir(cwd, { recursive: true });
		await writeSkill(
			path.join(agentDir, "skills", "global-skill"),
			"global-skill",
			"# Global instructions",
		);
		const projection = await discoverAndProjectSkills({
			cwd,
			agentDir,
			projectTrusted: false,
			preloadSkills: ["global-skill"],
		});
		expect(projection.catalog.map((skill) => skill.name)).toEqual([
			"global-skill",
		]);
		expect(projection.catalog[0]?.guestFilePath).toMatch(
			/^\/skills\/[a-f0-9]{16}\/global-skill\/SKILL\.md$/,
		);
		expect(projection.preloadPrompt).toContain("# Global instructions");
		expect(projection.preloadPrompt).toContain(
			projection.catalog[0]?.guestFilePath,
		);
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager: SettingsManager.inMemory(),
			noSkills: true,
			noExtensions: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			skillsOverride: (base) => ({
				skills: projection.catalog.map((skill) => skill.skill),
				diagnostics: base.diagnostics,
			}),
		});
		await loader.reload();
		expect(loader.getSkills().skills[0]?.filePath).toBe(
			projection.catalog[0]?.guestFilePath,
		);
	});

	it("loads project skills only when project trust is granted", async () => {
		const base = root("project");
		const agentDir = path.join(base, "agent");
		const cwd = path.join(base, "project");
		await mkdir(agentDir, { recursive: true });
		await writeSkill(
			path.join(cwd, ".pi", "skills", "project-skill"),
			"project-skill",
			"# Project instructions",
		);
		const untrusted = await discoverAndProjectSkills({
			cwd,
			agentDir,
			projectTrusted: false,
			preloadSkills: [],
		});
		expect(untrusted.catalog).toEqual([]);
		const trusted = await discoverAndProjectSkills({
			cwd,
			agentDir,
			projectTrusted: true,
			preloadSkills: ["project-skill"],
		});
		expect(trusted.catalog.map((skill) => skill.name)).toEqual([
			"project-skill",
		]);
	});

	it("fails preflight when a forced preload is unavailable", async () => {
		const base = root("missing");
		const agentDir = path.join(base, "agent");
		const cwd = path.join(base, "project");
		await mkdir(agentDir, { recursive: true });
		await mkdir(cwd, { recursive: true });
		await expect(
			discoverAndProjectSkills({
				cwd,
				agentDir,
				projectTrusted: false,
				preloadSkills: ["missing-skill"],
			}),
		).rejects.toBeInstanceOf(SkillProjectionError);
	});
});
