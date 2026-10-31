import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_SLOTS, MAX_SLOTS } from "../src/contracts.js";
import {
	readSubagentSettings,
	SubagentSettingsError,
	subagentSettingsPath,
} from "../src/settings.js";

async function agentDirWith(content?: string): Promise<string> {
	const agentDir = path.resolve(".pi", "test-settings", randomUUID());
	await mkdir(path.join(agentDir, "subagents"), { recursive: true });
	if (content !== undefined) {
		await writeFile(subagentSettingsPath(agentDir), content);
	}
	return agentDir;
}

describe("subagent settings", () => {
	it("defaults to sixteen slots without a settings file", async () => {
		expect(DEFAULT_MAX_SLOTS).toBe(16);
		expect(readSubagentSettings(await agentDirWith())).toEqual({
			maxSlots: 16,
		});
		expect(readSubagentSettings(await agentDirWith("{}"))).toEqual({
			maxSlots: 16,
		});
	});

	it("reads maxSlots within 1 to 32", async () => {
		expect(MAX_SLOTS).toBe(32);
		for (const maxSlots of [1, 4, 32]) {
			expect(
				readSubagentSettings(await agentDirWith(JSON.stringify({ maxSlots }))),
			).toEqual({ maxSlots });
		}
	});

	it.each([
		["not JSON", "{", "the file is not JSON"],
		["zero slots", '{"maxSlots":0}', 'only "maxSlots"'],
		["too many slots", '{"maxSlots":33}', 'only "maxSlots"'],
		["fractional slots", '{"maxSlots":2.5}', 'only "maxSlots"'],
		["unknown keys", '{"maxSlots":4,"slots":4}', 'only "maxSlots"'],
		["a non-object", "[]", 'only "maxSlots"'],
	])("refuses %s by name and path", async (_name, content, reason) => {
		const agentDir = await agentDirWith(content);
		const read = () => readSubagentSettings(agentDir);
		expect(read).toThrow(SubagentSettingsError);
		expect(read).toThrow(
			`Invalid pi-subagent settings at ${subagentSettingsPath(agentDir)}`,
		);
		expect(read).toThrow(reason);
	});
});
