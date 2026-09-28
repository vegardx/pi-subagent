import type { EventBus } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import {
	type ExactModelRequest,
	ExactModelRequestSchema,
} from "./launch-contracts.js";

const SESSION_MODEL_REQUEST_CHANNEL =
	"@vegardx/pi-subagent/session-model-provider/request/v1";

/**
 * A host's answer for the session a delegation inherits from: the model the
 * person is working with right now, and the thinking level it runs at.
 * `undefined` is no session model, which is also what an unregistered host
 * means; an inherited request then refuses rather than guessing one.
 */
export type SessionModelProvider = () => ExactModelRequest | undefined;

type SessionModelRequest = {
	schema: "pi-subagent-session-model-request-v1";
	respond(model: ExactModelRequest | undefined): void;
};

export class SessionModelProviderError extends Error {
	constructor(
		readonly code: "duplicate" | "invalid",
		message: string,
	) {
		super(message);
		this.name = "SessionModelProviderError";
	}
}

function isSessionModelRequest(value: unknown): value is SessionModelRequest {
	if (typeof value !== "object" || value === null) return false;
	const request = value as Partial<SessionModelRequest>;
	return (
		request.schema === "pi-subagent-session-model-request-v1" &&
		typeof request.respond === "function"
	);
}

function collect(events: EventBus): Array<ExactModelRequest | undefined> {
	const answers: Array<ExactModelRequest | undefined> = [];
	const request: SessionModelRequest = {
		schema: "pi-subagent-session-model-request-v1",
		respond(model) {
			answers.push(model);
		},
	};
	events.emit(SESSION_MODEL_REQUEST_CHANNEL, request);
	return answers;
}

/**
 * Register the one provider that answers what the host session is running on.
 * The host states an exact model in this runtime's own vocabulary; a request
 * that asks to inherit resolves through this provider and is compiled with the
 * exact answer. Returns the unregistration handle.
 */
export function registerSessionModelProvider(
	events: EventBus,
	provider: SessionModelProvider,
): () => void {
	if (collect(events).length !== 0) {
		throw new SessionModelProviderError(
			"duplicate",
			"A pi-subagent session model provider is already registered.",
		);
	}
	return events.on(SESSION_MODEL_REQUEST_CHANNEL, (value) => {
		if (!isSessionModelRequest(value)) return;
		value.respond(provider());
	});
}

/**
 * The host session's model, or `undefined` when no host has registered a
 * provider or the provider has no session model to give. Fails closed on a
 * duplicate registration or an answer that does not satisfy the contract
 * rather than compiling a model no host stands behind.
 */
export function resolveSessionModel(
	events: EventBus,
): ExactModelRequest | undefined {
	const answers = collect(events);
	if (answers.length === 0) return undefined;
	if (answers.length !== 1) {
		throw new SessionModelProviderError(
			"duplicate",
			`Expected one pi-subagent session model provider, received ${answers.length}.`,
		);
	}
	const model = answers[0];
	if (model === undefined) return undefined;
	if (!Value.Check(ExactModelRequestSchema, model)) {
		throw new SessionModelProviderError(
			"invalid",
			"The registered pi-subagent session model provider returned a model that violates the contract.",
		);
	}
	return model;
}
