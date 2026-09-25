import type { EventBus } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import {
	type DelegationCeiling,
	DelegationCeilingSchema,
} from "./launch-contracts.js";

const CEILING_REQUEST_CHANNEL =
	"@vegardx/pi-subagent/ceiling-provider/request/v1";

/**
 * A host's answer for one delegation. `undefined` is no bound at all, which is
 * also what an unregistered host means.
 */
export type DelegationCeilingProvider = () => DelegationCeiling | undefined;

type CeilingRequest = {
	schema: "pi-subagent-ceiling-request-v1";
	respond(ceiling: DelegationCeiling | undefined): void;
};

export class DelegationCeilingProviderError extends Error {
	constructor(
		readonly code: "duplicate" | "invalid",
		message: string,
	) {
		super(message);
		this.name = "DelegationCeilingProviderError";
	}
}

function isCeilingRequest(value: unknown): value is CeilingRequest {
	if (typeof value !== "object" || value === null) return false;
	const request = value as Partial<CeilingRequest>;
	return (
		request.schema === "pi-subagent-ceiling-request-v1" &&
		typeof request.respond === "function"
	);
}

function collect(events: EventBus): Array<DelegationCeiling | undefined> {
	const answers: Array<DelegationCeiling | undefined> = [];
	const request: CeilingRequest = {
		schema: "pi-subagent-ceiling-request-v1",
		respond(ceiling) {
			answers.push(ceiling);
		},
	};
	events.emit(CEILING_REQUEST_CHANNEL, request);
	return answers;
}

/**
 * Register the one provider that bounds every delegation this process
 * launches. The host states the bound in this runtime's own vocabulary; it
 * never names a host mode here. Returns the unregistration handle.
 */
export function registerDelegationCeilingProvider(
	events: EventBus,
	provider: DelegationCeilingProvider,
): () => void {
	if (collect(events).length !== 0) {
		throw new DelegationCeilingProviderError(
			"duplicate",
			"A pi-subagent delegation ceiling provider is already registered.",
		);
	}
	return events.on(CEILING_REQUEST_CHANNEL, (value) => {
		if (!isCeilingRequest(value)) return;
		value.respond(provider());
	});
}

/**
 * The ceiling that bounds the next launch, or `undefined` when no host has
 * registered one. Fails closed on a duplicate registration or a ceiling that
 * does not satisfy the contract rather than launching unbounded.
 */
export function resolveDelegationCeiling(
	events: EventBus,
): DelegationCeiling | undefined {
	const answers = collect(events);
	if (answers.length === 0) return undefined;
	if (answers.length !== 1) {
		throw new DelegationCeilingProviderError(
			"duplicate",
			`Expected one pi-subagent delegation ceiling provider, received ${answers.length}.`,
		);
	}
	const ceiling = answers[0];
	if (ceiling === undefined) return undefined;
	if (!Value.Check(DelegationCeilingSchema, ceiling)) {
		throw new DelegationCeilingProviderError(
			"invalid",
			"The registered pi-subagent delegation ceiling provider returned a ceiling that violates the contract.",
		);
	}
	return ceiling;
}
