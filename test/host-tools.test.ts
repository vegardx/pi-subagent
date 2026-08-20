import type { EventBus } from "@earendil-works/pi-coding-agent";
import { WEB_RUNTIME_CONTRACT, WEB_TOOL_DECLARATIONS } from "@vegardx/pi-web";
import { describe, expect, it } from "vitest";
import {
	discoverWebHostTools,
	executeBoundedHostTool,
	HostToolProviderError,
	hostToolMap,
} from "../src/runtime/host-tools.js";

class FakeEvents {
	private readonly handlers = new Map<
		string,
		Array<(value: unknown) => void>
	>();
	on(channel: string, handler: (value: unknown) => void): void {
		const list = this.handlers.get(channel) ?? [];
		list.push(handler);
		this.handlers.set(channel, list);
	}
	emit(channel: string, value: unknown): void {
		for (const handler of this.handlers.get(channel) ?? []) handler(value);
	}
}

function provider() {
	return {
		contract: WEB_RUNTIME_CONTRACT,
		delegatedTools: WEB_TOOL_DECLARATIONS.map((declaration) => ({
			name: declaration.name,
			label: declaration.label,
			description: declaration.description,
			promptGuidelines: declaration.promptGuidelines,
			parameters: declaration.parameters,
			authority: declaration.authority,
			identitySha256: declaration.identitySha256,
			execute: async () => ({
				content: [{ type: "text" as const, text: declaration.name }],
				details: {},
			}),
		})),
		acquire: async () => ({}),
	};
}

function eventsWith(...providers: unknown[]): EventBus {
	const events = new FakeEvents();
	for (const candidate of providers) {
		events.on("@vegardx/pi-web/service-provider/request/v1", (value) => {
			(value as { respond(provider: unknown): void }).respond(candidate);
		});
	}
	return events as unknown as EventBus;
}

describe("host-brokered web tools", () => {
	it("is optional when pi-web is absent", () => {
		expect(discoverWebHostTools(eventsWith())).toEqual([]);
	});

	it("projects exact tool identity and execution", async () => {
		const tools = discoverWebHostTools(eventsWith(provider()));
		expect(tools.map((tool) => tool.name)).toEqual(["search", "fetch"]);
		expect(tools[0]?.source).toBe("@vegardx/pi-web/service-provider@3#search");
		expect(hostToolMap(tools).get("fetch")?.identitySha256).toMatch(
			/^[a-f0-9]{64}$/,
		);
		expect(
			await tools[0]?.execute(
				{ id: "owner", runId: "run_test", attemptId: "attempt_test" },
				{},
			),
		).toMatchObject({ content: [{ text: "search" }] });
	});

	it("bounds results and prevents execution after cancellation", async () => {
		const [search] = discoverWebHostTools(eventsWith(provider()));
		if (!search) throw new Error("search tool missing");
		const large = {
			...search,
			execute: async () => ({
				content: [{ type: "text" as const, text: "x\n".repeat(30_000) }],
				details: {},
			}),
		};
		const result = await executeBoundedHostTool(
			large,
			{ id: "owner", runId: "run_test", attemptId: "attempt_test" },
			{},
			new AbortController().signal,
		);
		const content = result.content[0];
		if (content?.type !== "text") throw new Error("text result missing");
		expect(Buffer.byteLength(content.text)).toBeLessThanOrEqual(50 * 1024);
		expect(content.text.split("\n").length).toBeLessThanOrEqual(2000);

		let called = false;
		const controller = new AbortController();
		controller.abort(new Error("parent cancelled"));
		await expect(
			executeBoundedHostTool(
				{
					...search,
					execute: async () => {
						called = true;
						return { content: [], details: {} };
					},
				},
				{ id: "owner", runId: "run_test", attemptId: "attempt_test" },
				{},
				controller.signal,
			),
		).rejects.toThrow("parent cancelled");
		expect(called).toBe(false);
	});

	it("rejects duplicate and incompatible providers", () => {
		expect(() =>
			discoverWebHostTools(eventsWith(provider(), provider())),
		).toThrow(HostToolProviderError);
		expect(() =>
			discoverWebHostTools(eventsWith({ ...provider(), delegatedTools: [] })),
		).toThrow("must declare exactly search and fetch");
		expect(() =>
			discoverWebHostTools(
				eventsWith({
					...provider(),
					contract: { ...WEB_RUNTIME_CONTRACT, extra: true },
				}),
			),
		).toThrow("incompatible");
	});
});
