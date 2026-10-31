import { readFileSync } from "node:fs";
import path from "node:path";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { DEFAULT_MAX_SLOTS, MAX_SLOTS } from "./contracts.js";

/** Host settings of this runtime, owned by the operator. */
export const SubagentSettingsSchema = Type.Object(
	{
		maxSlots: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SLOTS })),
	},
	{ additionalProperties: false },
);
export type SubagentSettingsFile = Static<typeof SubagentSettingsSchema>;

export type SubagentSettings = {
	/** Concurrent VMs this host runs across every seat. */
	maxSlots: number;
};

export const DEFAULT_SUBAGENT_SETTINGS: Readonly<SubagentSettings> =
	Object.freeze({ maxSlots: DEFAULT_MAX_SLOTS });

export class SubagentSettingsError extends Error {
	readonly settingsPath: string;

	constructor(settingsPath: string, reason: string) {
		super(`Invalid pi-subagent settings at ${settingsPath}: ${reason}`);
		this.name = "SubagentSettingsError";
		this.settingsPath = settingsPath;
	}
}

export function subagentSettingsPath(agentDir: string): string {
	return path.join(agentDir, "subagents", "settings.json");
}

/**
 * Read `<agentDir>/subagents/settings.json`. A missing file means defaults; a
 * file that exists but does not match the schema is refused, never partly
 * applied. Synchronous because the extension publishes its runtime contract,
 * which reports `maxSlots`, while it loads.
 */
export function readSubagentSettings(agentDir: string): SubagentSettings {
	const settingsPath = subagentSettingsPath(agentDir);
	let text: string;
	try {
		text = readFileSync(settingsPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { ...DEFAULT_SUBAGENT_SETTINGS };
		}
		throw new SubagentSettingsError(settingsPath, "the file is unreadable");
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new SubagentSettingsError(settingsPath, "the file is not JSON");
	}
	if (!Value.Check(SubagentSettingsSchema, value)) {
		throw new SubagentSettingsError(
			settingsPath,
			`expected an object with only "maxSlots", an integer from 1 to ${MAX_SLOTS}`,
		);
	}
	return { maxSlots: value.maxSlots ?? DEFAULT_SUBAGENT_SETTINGS.maxSlots };
}
