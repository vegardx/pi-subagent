import { createHash } from "node:crypto";
import {
	type AgentToolResult,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type EventBus,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

const WEB_PROVIDER_CHANNEL = "@vegardx/pi-web/service-provider/request/v1";
const SHA256 = /^[a-f0-9]{64}$/;
const HOST_TOOL_TIMEOUT_MS = 60_000;
const MAX_DETAILS_BYTES = 64 * 1024;

export interface HostToolOwner {
	readonly id: string;
	readonly runId: string;
	readonly attemptId: string;
}

export interface HostToolDeclaration {
	readonly name: string;
	readonly label: string;
	readonly description: string;
	readonly promptGuidelines: readonly string[];
	readonly parameters: TSchema;
	readonly authority: "public-network-read";
	readonly source: string;
	readonly identitySha256: string;
	execute(
		owner: HostToolOwner,
		input: unknown,
		signal?: AbortSignal,
	): Promise<AgentToolResult<unknown>>;
}

interface WebProviderRequest {
	readonly schema: "pi-web-service-request-v1";
	respond(provider: unknown): void;
}

interface WebProvider {
	readonly contract: {
		readonly schema: "pi-web-runtime";
		readonly contractRevision: 3;
		readonly features: {
			readonly interactiveTools: true;
			readonly delegatedTools: true;
			readonly exaSearch: true;
			readonly exaFetch: true;
			readonly context7Search: true;
			readonly context7Fetch: true;
			readonly persistentResources: false;
			readonly repositorySnapshots: false;
		};
	};
	readonly delegatedTools: readonly unknown[];
	acquire(): Promise<unknown>;
}

export class HostToolProviderError extends Error {
	constructor(
		readonly code: "duplicate" | "incompatible",
		message: string,
	) {
		super(message);
		this.name = "HostToolProviderError";
	}
}

function exactKeys(value: object, expected: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	return (
		actual.length === expected.length &&
		actual.every((key, index) => key === [...expected].sort()[index])
	);
}

function provider(value: unknown): value is WebProvider {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<WebProvider>;
	const features = candidate.contract?.features;
	return (
		candidate.contract !== undefined &&
		exactKeys(candidate.contract, ["schema", "contractRevision", "features"]) &&
		features !== undefined &&
		exactKeys(features, [
			"interactiveTools",
			"delegatedTools",
			"exaSearch",
			"exaFetch",
			"context7Search",
			"context7Fetch",
			"persistentResources",
			"repositorySnapshots",
		]) &&
		candidate.contract.schema === "pi-web-runtime" &&
		candidate.contract.contractRevision === 3 &&
		features?.interactiveTools === true &&
		features.delegatedTools === true &&
		features.exaSearch === true &&
		features.exaFetch === true &&
		features.context7Search === true &&
		features.context7Fetch === true &&
		features.persistentResources === false &&
		features.repositorySnapshots === false &&
		Array.isArray(candidate.delegatedTools) &&
		typeof candidate.acquire === "function"
	);
}

const EXPECTED_TOOL_IDENTITIES: Readonly<Record<"search" | "fetch", string>> =
	Object.freeze({
		search: "8b1ac9374b8528fb0cf7c60597c60b695d11868c8b469b29a9f2712ba90cf8de",
		fetch: "32c7249426271da1355b7fa08e3d22bb346683254495ed3a284cd7d2102ad163",
	});

function declarationIdentity(value: {
	name: string;
	label: string;
	description: string;
	promptGuidelines: readonly string[];
	parameters: unknown;
	authority: string;
}): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				contractRevision: 3,
				implementationRevision: 1,
				name: value.name,
				label: value.label,
				description: value.description,
				promptGuidelines: value.promptGuidelines,
				parameters: value.parameters,
				authority: value.authority,
			}),
		)
		.digest("hex");
}

function tool(value: unknown): value is Omit<HostToolDeclaration, "source"> {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<HostToolDeclaration>;
	return (
		(candidate.name === "search" || candidate.name === "fetch") &&
		typeof candidate.label === "string" &&
		typeof candidate.description === "string" &&
		Array.isArray(candidate.promptGuidelines) &&
		candidate.promptGuidelines.every((line) => typeof line === "string") &&
		typeof candidate.parameters === "object" &&
		candidate.parameters !== null &&
		candidate.authority === "public-network-read" &&
		typeof candidate.identitySha256 === "string" &&
		SHA256.test(candidate.identitySha256) &&
		candidate.identitySha256 === EXPECTED_TOOL_IDENTITIES[candidate.name] &&
		candidate.identitySha256 ===
			declarationIdentity({
				name: candidate.name,
				label: candidate.label,
				description: candidate.description,
				promptGuidelines: candidate.promptGuidelines,
				parameters: candidate.parameters,
				authority: candidate.authority,
			}) &&
		typeof candidate.execute === "function"
	);
}

function frozenJson<T>(value: T): T {
	const clone = JSON.parse(JSON.stringify(value)) as T;
	const freeze = (entry: unknown): void => {
		if (typeof entry !== "object" || entry === null || Object.isFrozen(entry)) {
			return;
		}
		for (const child of Object.values(entry)) freeze(child);
		Object.freeze(entry);
	};
	freeze(clone);
	return clone;
}

export function discoverWebHostTools(
	events: EventBus,
): readonly HostToolDeclaration[] {
	const providers: unknown[] = [];
	const request: WebProviderRequest = {
		schema: "pi-web-service-request-v1",
		respond(value) {
			providers.push(value);
		},
	};
	events.emit(WEB_PROVIDER_CHANNEL, request);
	if (providers.length === 0) return Object.freeze([]);
	if (providers.length !== 1) {
		throw new HostToolProviderError(
			"duplicate",
			`Expected one pi-web provider, received ${providers.length}.`,
		);
	}
	const selected = providers[0];
	if (!provider(selected) || !selected.delegatedTools.every(tool)) {
		throw new HostToolProviderError(
			"incompatible",
			"The registered pi-web delegated tool provider is incompatible.",
		);
	}
	const names = new Set<string>();
	const tools = selected.delegatedTools.map((declaration) => {
		if (!tool(declaration) || names.has(declaration.name)) {
			throw new HostToolProviderError(
				"incompatible",
				"The pi-web provider contains duplicate or invalid tools.",
			);
		}
		names.add(declaration.name);
		return Object.freeze({
			...declaration,
			promptGuidelines: Object.freeze([...declaration.promptGuidelines]),
			parameters: frozenJson(declaration.parameters),
			source: `@vegardx/pi-web/service-provider@3#${declaration.name}`,
		});
	});
	if (names.size !== 2 || !names.has("search") || !names.has("fetch")) {
		throw new HostToolProviderError(
			"incompatible",
			"The pi-web provider must declare exactly search and fetch.",
		);
	}
	return Object.freeze(tools);
}

export async function executeBoundedHostTool(
	declaration: HostToolDeclaration,
	owner: HostToolOwner,
	input: unknown,
	parentSignal: AbortSignal,
): Promise<AgentToolResult<unknown>> {
	parentSignal.throwIfAborted();
	const timeout = AbortSignal.timeout(HOST_TOOL_TIMEOUT_MS);
	const signal = AbortSignal.any([parentSignal, timeout]);
	let rejectTimeout: ((error: Error) => void) | undefined;
	const timeoutResult = new Promise<never>((_resolve, reject) => {
		rejectTimeout = reject;
	});
	const onAbort = () => {
		rejectTimeout?.(
			signal.reason instanceof Error
				? signal.reason
				: new Error("host tool execution aborted"),
		);
	};
	signal.addEventListener("abort", onAbort, { once: true });
	if (signal.aborted) onAbort();
	try {
		const result = await Promise.race([
			declaration.execute(owner, input, signal),
			timeoutResult,
		]);
		if (
			typeof result !== "object" ||
			result === null ||
			!Array.isArray(result.content) ||
			result.addedToolNames !== undefined
		) {
			throw new Error(`invalid host tool result: ${declaration.name}`);
		}
		const text = result.content
			.map((content) => {
				if (content.type !== "text") {
					throw new Error("host tools may return text content only");
				}
				return content.text;
			})
			.join("\n");
		const bounded = truncateHead(text, {
			maxBytes: DEFAULT_MAX_BYTES,
			maxLines: DEFAULT_MAX_LINES,
		});
		let detailsJson: string;
		try {
			detailsJson = JSON.stringify(result.details ?? null);
		} catch (error) {
			throw new Error("host tool details are not serializable", {
				cause: error,
			});
		}
		if (Buffer.byteLength(detailsJson) > MAX_DETAILS_BYTES) {
			throw new Error("host tool details exceed size limit");
		}
		return {
			content: [{ type: "text", text: bounded.content }],
			details: JSON.parse(detailsJson) as unknown,
			...(result.usage ? { usage: result.usage } : {}),
		};
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

export function hostToolMap(
	tools: readonly HostToolDeclaration[],
): ReadonlyMap<string, HostToolDeclaration> {
	const mapped = new Map<string, HostToolDeclaration>();
	for (const declaration of tools) {
		if (mapped.has(declaration.name)) {
			throw new Error(`duplicate host tool: ${declaration.name}`);
		}
		mapped.set(declaration.name, declaration);
	}
	return mapped;
}
