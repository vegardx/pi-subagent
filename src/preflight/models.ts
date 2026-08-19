import {
	type Api,
	getSupportedThinkingLevels,
	type Model,
} from "@earendil-works/pi-ai";
import type { ExactModelRequest } from "../launch-contracts.js";

export type ModelPreflightRuntime = {
	getModel(providerId: string, modelId: string): Model<Api> | undefined;
	getAvailable(
		providerId?: string,
		options?: { signal?: AbortSignal },
	): Promise<readonly Model<Api>[]>;
};

export type ResolvedPiModel = {
	selection: ExactModelRequest;
	model: Model<Api>;
};

export class ModelPreflightError extends Error {
	readonly code:
		| "model-not-found"
		| "authentication-unavailable"
		| "thinking-unsupported";

	constructor(
		code: ModelPreflightError["code"],
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "ModelPreflightError";
		this.code = code;
	}
}

export async function resolveExactPiModel(
	runtime: ModelPreflightRuntime,
	selection: ExactModelRequest,
	signal?: AbortSignal,
): Promise<ResolvedPiModel> {
	signal?.throwIfAborted();
	const model = runtime.getModel(selection.provider, selection.id);
	if (!model) {
		throw new ModelPreflightError(
			"model-not-found",
			`model not found: ${selection.provider}/${selection.id}`,
		);
	}
	const supportedThinking = getSupportedThinkingLevels(model);
	if (!supportedThinking.includes(selection.thinking)) {
		throw new ModelPreflightError(
			"thinking-unsupported",
			`thinking level unsupported: ${selection.thinking}`,
		);
	}

	let available: readonly Model<Api>[];
	try {
		available = await runtime.getAvailable(
			selection.provider,
			signal ? { signal } : undefined,
		);
	} catch (error) {
		signal?.throwIfAborted();
		throw new ModelPreflightError(
			"authentication-unavailable",
			`model authentication check failed: ${selection.provider}`,
			{ cause: error },
		);
	}
	signal?.throwIfAborted();
	const authenticated = available.some(
		(candidate) =>
			candidate.provider === selection.provider &&
			candidate.id === selection.id,
	);
	if (!authenticated) {
		throw new ModelPreflightError(
			"authentication-unavailable",
			`model authentication unavailable: ${selection.provider}/${selection.id}`,
		);
	}
	return { selection: { ...selection }, model };
}

export function createExactModelResolver(
	runtime: ModelPreflightRuntime,
	signal?: AbortSignal,
): (selection: ExactModelRequest) => Promise<ExactModelRequest> {
	return async (selection) =>
		(await resolveExactPiModel(runtime, selection, signal)).selection;
}
