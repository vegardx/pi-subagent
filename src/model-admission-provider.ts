import type { EventBus } from "@earendil-works/pi-coding-agent";
import type { ExactModelRequest } from "./launch-contracts.js";

const MODEL_ADMISSION_REQUEST_CHANNEL =
	"@vegardx/pi-subagent/model-admission-provider/request/v1";

/**
 * A host's answer for one exact model a launch asks to run on: `true` when the
 * host stands behind it (its own rosters, regions, and authentication), `false`
 * when it does not. Consulted only for a definition whose `allowedModels`
 * admits `host`.
 */
export type ModelAdmissionProvider = (model: ExactModelRequest) => boolean;

/**
 * A request without a model is the registration probe: it counts registered
 * providers without asking any of them about a model nobody launches.
 */
type ModelAdmissionRequest = {
	schema: "pi-subagent-model-admission-request-v1";
	model?: ExactModelRequest;
	respond(admitted: boolean): void;
};

export class ModelAdmissionProviderError extends Error {
	constructor(
		readonly code: "duplicate" | "invalid",
		message: string,
	) {
		super(message);
		this.name = "ModelAdmissionProviderError";
	}
}

function isModelAdmissionRequest(
	value: unknown,
): value is ModelAdmissionRequest {
	if (typeof value !== "object" || value === null) return false;
	const request = value as Partial<ModelAdmissionRequest>;
	return (
		request.schema === "pi-subagent-model-admission-request-v1" &&
		typeof request.respond === "function"
	);
}

function collect(events: EventBus, model?: ExactModelRequest): unknown[] {
	const answers: unknown[] = [];
	const request: ModelAdmissionRequest = {
		schema: "pi-subagent-model-admission-request-v1",
		// A copy, so a provider cannot change the model the plan will record.
		...(model ? { model: { ...model } } : {}),
		respond(admitted) {
			answers.push(admitted);
		},
	};
	events.emit(MODEL_ADMISSION_REQUEST_CHANNEL, request);
	return answers;
}

/**
 * Register the one provider that says which exact models the host stands
 * behind. A definition that admits `host` hands its model fence to this
 * provider. Returns the unregistration handle.
 */
export function registerModelAdmissionProvider(
	events: EventBus,
	provider: ModelAdmissionProvider,
): () => void {
	if (collect(events).length !== 0) {
		throw new ModelAdmissionProviderError(
			"duplicate",
			"A pi-subagent model admission provider is already registered.",
		);
	}
	return events.on(MODEL_ADMISSION_REQUEST_CHANNEL, (value) => {
		if (!isModelAdmissionRequest(value)) return;
		if (value.model === undefined) {
			value.respond(true);
			return;
		}
		value.respond(provider(value.model));
	});
}

/**
 * Whether the host stands behind `model`, or `undefined` when no host has
 * registered a provider. Fails closed on a duplicate registration or an answer
 * that is not a boolean rather than admitting a model no host vouched for.
 */
export function resolveModelAdmission(
	events: EventBus,
	model: ExactModelRequest,
): boolean | undefined {
	const answers = collect(events, model);
	if (answers.length === 0) return undefined;
	if (answers.length !== 1) {
		throw new ModelAdmissionProviderError(
			"duplicate",
			`Expected one pi-subagent model admission provider, received ${answers.length}.`,
		);
	}
	const admitted = answers[0];
	if (typeof admitted !== "boolean") {
		throw new ModelAdmissionProviderError(
			"invalid",
			"The registered pi-subagent model admission provider returned an answer that violates the contract.",
		);
	}
	return admitted;
}
