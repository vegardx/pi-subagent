import type {
	EventBus,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import {
	SUBAGENT_RUNTIME_CONTRACT,
	type SubagentRuntimeContract,
	SubagentRuntimeContractSchema,
} from "./contracts.js";
import type { SubagentService } from "./service.js";

const SERVICE_REQUEST_CHANNEL =
	"@vegardx/pi-subagent/service-provider/request/v1";

export type SubagentServiceProvider = {
	readonly contract: SubagentRuntimeContract;
	acquire(context: ExtensionContext): Promise<SubagentService>;
};

type ServiceRequest = {
	schema: "pi-subagent-service-request-v1";
	respond(provider: unknown): void;
};

export class SubagentServiceProviderError extends Error {
	constructor(
		readonly code: "missing" | "duplicate" | "incompatible",
		message: string,
	) {
		super(message);
		this.name = "SubagentServiceProviderError";
	}
}

function isServiceRequest(value: unknown): value is ServiceRequest {
	if (typeof value !== "object" || value === null) return false;
	const request = value as Partial<ServiceRequest>;
	return (
		request.schema === "pi-subagent-service-request-v1" &&
		typeof request.respond === "function"
	);
}

function isCompatibleProvider(
	value: unknown,
): value is SubagentServiceProvider {
	if (typeof value !== "object" || value === null) return false;
	const provider = value as Partial<SubagentServiceProvider>;
	if (
		typeof provider.acquire !== "function" ||
		!Value.Check(SubagentRuntimeContractSchema, provider.contract)
	) {
		return false;
	}
	for (const feature of Object.keys(
		SUBAGENT_RUNTIME_CONTRACT.features,
	) as Array<keyof SubagentRuntimeContract["features"]>) {
		if (
			provider.contract.features[feature] !==
			SUBAGENT_RUNTIME_CONTRACT.features[feature]
		) {
			return false;
		}
	}
	return true;
}

export function registerSubagentServiceProvider(
	events: EventBus,
	acquire: (context: ExtensionContext) => Promise<SubagentService>,
): () => void {
	const provider: SubagentServiceProvider = {
		contract: SUBAGENT_RUNTIME_CONTRACT,
		acquire,
	};
	return events.on(SERVICE_REQUEST_CHANNEL, (value) => {
		if (!isServiceRequest(value)) return;
		value.respond(provider);
	});
}

export async function acquireSubagentService(
	events: EventBus,
	context: ExtensionContext,
): Promise<SubagentService> {
	const providers: unknown[] = [];
	const request: ServiceRequest = {
		schema: "pi-subagent-service-request-v1",
		respond(provider) {
			providers.push(provider);
		},
	};
	events.emit(SERVICE_REQUEST_CHANNEL, request);
	if (providers.length === 0) {
		throw new SubagentServiceProviderError(
			"missing",
			"No pi-subagent service provider is registered.",
		);
	}
	if (providers.length !== 1) {
		throw new SubagentServiceProviderError(
			"duplicate",
			`Expected one pi-subagent service provider, received ${providers.length}.`,
		);
	}
	const provider = providers[0];
	if (!isCompatibleProvider(provider)) {
		throw new SubagentServiceProviderError(
			"incompatible",
			"The registered pi-subagent service provider is incompatible.",
		);
	}
	return provider.acquire(context);
}
