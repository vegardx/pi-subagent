import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	ContextProjectionError,
	projectForkContext,
} from "../src/preflight/context.js";

async function parentSession() {
	const root = path.join(tmpdir(), `pi-subagent-context-${randomUUID()}`);
	await mkdir(root, { recursive: true });
	const manager = SessionManager.create(root, path.join(root, "sessions"), {
		id: `parent-${randomUUID()}`,
	});
	manager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "PARENT_CONTEXT_MARKER" }],
		timestamp: Date.now(),
	});
	const file = manager.getSessionFile();
	const header = manager.getHeader();
	if (!file || !header) throw new Error("parent session file missing");
	await writeFile(
		file,
		`${[header, ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
	);
	return { manager, file };
}

describe("fork context projection", () => {
	it("binds a bounded active parent-session context", async () => {
		const parent = await parentSession();
		const projection = await projectForkContext({
			parentSessionId: parent.manager.getSessionId(),
			parentSessionFile: parent.file,
		});
		expect(projection.messages).toHaveLength(1);
		expect(JSON.stringify(projection.messages)).toContain(
			"PARENT_CONTEXT_MARKER",
		);
		expect(projection.grant.parentSessionSha256).toMatch(/^[a-f0-9]{64}$/);
		expect(projection.grant.projectionSha256).toMatch(/^[a-f0-9]{64}$/);
		expect(projection.grant.messageIds).toHaveLength(1);
	});

	it("rejects parent identity mismatch", async () => {
		const parent = await parentSession();
		await expect(
			projectForkContext({
				parentSessionId: "different-parent",
				parentSessionFile: parent.file,
			}),
		).rejects.toBeInstanceOf(ContextProjectionError);
	});
});
