import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { RunSummary, SubagentService } from "../src/service.js";
import {
	actionsForRun,
	attentionWidgetLines,
	showSubagentInspector,
} from "../src/ui/inspector.js";

function summary(
	status: RunSummary["status"],
	overrides: Partial<RunSummary> = {},
): RunSummary {
	return {
		runId: "run_inspector",
		attemptId: "attempt_inspector",
		ownerId: "owner",
		agentName: "worker",
		agentDisplayName: "Worker",
		goalPreview: "Inspect the operator experience",
		status,
		repositoryRoot: "/repository",
		workspaceMode: "read-only",
		createdAt: "2026-08-19T00:00:00.000Z",
		updatedAt: "2026-08-19T00:00:01.000Z",
		pinned: false,
		controllable: status === "active",
		retryable: status === "failed",
		resumable: status === "interrupted",
		retainedWorktree: false,
		requiresAttention: status === "active" || status === "interrupted",
		...overrides,
	};
}

describe("subagent inspector", () => {
	it("offers only state-valid actions through the palette", () => {
		expect(actionsForRun(summary("active"))).toEqual([
			"steer",
			"follow-up",
			"stop",
			"pin",
		]);
		expect(
			actionsForRun(
				summary("interrupted", {
					retainedWorktree: true,
					pinned: true,
				}),
			),
		).toEqual(["resume", "release", "unpin"]);
		expect(actionsForRun(summary("interrupted", { resumable: false }))).toEqual(
			["pin"],
		);
		expect(actionsForRun(summary("cleanup-blocked"))).toEqual([
			"reconcile",
			"pin",
		]);
	});

	it("hides the ambient widget unless a run needs attention", () => {
		expect(attentionWidgetLines([summary("completed")])).toBeUndefined();
		expect(
			attentionWidgetLines([
				summary("active"),
				summary("interrupted", { runId: "run_interrupted" }),
			]),
		).toEqual(["subagents: 1 active · 1 interrupted · alt+s"]);
	});

	it("bounds every dashboard line to the available width", async () => {
		const runs = [
			summary("active", {
				agentDisplayName:
					"An intentionally very long delegated agent display name",
				goalPreview:
					"A deliberately long task description that must remain bounded in a narrow terminal",
			}),
		];
		const service = {
			listRuns: async () => ({ runs, total: runs.length }),
			subscribe: () => () => {},
		} as unknown as SubagentService;
		const rendered: string[][] = [];
		const theme = {
			fg: (_color: string, text: string) => text,
			bg: (_color: string, text: string) => text,
		};
		const ctx = {
			ui: {
				theme,
				custom: async (
					factory: (
						tui: { requestRender(): void },
						themeValue: typeof theme,
						keybindings: object,
						done: (value: unknown) => void,
					) => {
						render(width: number): string[];
						handleInput(data: string): void;
					},
				) => {
					let result: unknown;
					const component = factory(
						{ requestRender() {} },
						theme,
						{},
						(value: unknown) => {
							result = value;
						},
					);
					rendered.push(component.render(60));
					component.handleInput("\u001b");
					return result;
				},
			},
		} as unknown as ExtensionCommandContext;
		await showSubagentInspector({
			ctx,
			service,
			repositoryRoot: "/repository",
		});
		expect(rendered).toHaveLength(1);
		for (const line of rendered[0] ?? []) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(60);
		}
	});
});
