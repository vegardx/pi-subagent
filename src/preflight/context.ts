import { convertToLlm } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { canonicalSha256 } from "./canonical.js";
import { digestFileResource } from "./resources.js";

const MAX_FORK_MESSAGES = 100;
const MAX_FORK_BYTES = 256 * 1024;

export type ForkContextGrant = {
	parentSessionId: string;
	parentSessionSha256: string;
	messageIds: string[];
	projectionSha256: string;
};

export type ForkContextProjection = {
	grant: ForkContextGrant;
	parentSessionFile: string;
	messages: Message[];
};

export class ContextProjectionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ContextProjectionError";
	}
}

export async function projectForkContext(options: {
	parentSessionId: string;
	parentSessionFile: string;
}): Promise<ForkContextProjection> {
	const digest = await digestFileResource(options.parentSessionFile, {
		maxFiles: 1,
		maxBytes: 16 * 1024 * 1024,
	});
	const manager = SessionManager.open(digest.canonicalPath);
	const header = manager.getHeader();
	if (!header || header.id !== options.parentSessionId) {
		throw new ContextProjectionError("parent session identity mismatch");
	}
	const entries = manager.buildContextEntries();
	const messages = convertToLlm(manager.buildSessionContext().messages);
	if (entries.length > MAX_FORK_MESSAGES) {
		throw new ContextProjectionError("fork context exceeds entry limit");
	}
	if (messages.length > MAX_FORK_MESSAGES) {
		throw new ContextProjectionError("fork context exceeds message limit");
	}
	const serialized = JSON.stringify(messages);
	if (Buffer.byteLength(serialized) > MAX_FORK_BYTES) {
		throw new ContextProjectionError("fork context exceeds byte limit");
	}
	const messageIds = entries.map((entry) => entry.id);
	const projectionSha256 = canonicalSha256({ messageIds, messages });
	return {
		grant: {
			parentSessionId: options.parentSessionId,
			parentSessionSha256: digest.sha256,
			messageIds,
			projectionSha256,
		},
		parentSessionFile: digest.canonicalPath,
		messages: messages.map((message) => structuredClone(message)),
	};
}
