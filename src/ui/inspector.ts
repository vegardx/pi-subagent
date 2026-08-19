import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	Input,
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { RetentionReport } from "../persistence/retention.js";
import type {
	RunInspection,
	RunLogPage,
	RunSummary,
	SubagentService,
} from "../service.js";

export type InspectorAction =
	| "steer"
	| "follow-up"
	| "stop"
	| "retry"
	| "resume"
	| "reconcile"
	| "release"
	| "pin"
	| "unpin"
	| "export-output";

export type InspectorState = {
	allProjects: boolean;
	view: "runs" | "detail";
	selectedRunId?: string;
	tab: "overview" | "activity" | "result" | "technical";
	search?: string;
	statuses?: RunSummary["status"][];
};

export type InspectorIntent =
	| { type: "close"; state: InspectorState }
	| {
			type: "action";
			action: InspectorAction;
			run: RunSummary;
			state: InspectorState;
			text?: string;
			confirmed?: true;
	  }
	| { type: "retention"; state: InspectorState }
	| { type: "search"; state: InspectorState }
	| { type: "filter"; state: InspectorState };

type Screen = "runs" | "detail" | "actions" | "input" | "confirm" | "help";
type Theme = ExtensionContext["ui"]["theme"];

const TABS: InspectorState["tab"][] = [
	"overview",
	"activity",
	"result",
	"technical",
];

const STATUS_ICON: Record<RunSummary["status"], string> = {
	queued: "○",
	active: "▶",
	stopping: "■",
	completed: "✓",
	failed: "●",
	cancelled: "−",
	interrupted: "!",
	"cleanup-blocked": "✕",
};

function formatAge(timestamp: string, now = Date.now()): string {
	const milliseconds = Math.max(0, now - Date.parse(timestamp));
	const seconds = Math.floor(milliseconds / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}

function formatTokens(tokens: number): string {
	if (tokens < 1000) return String(tokens);
	return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	if (bytes < 1024 * 1024 * 1024) {
		return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
	}
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

function shortId(value: string): string {
	return value.length <= 14 ? value : `${value.slice(0, 12)}…`;
}

function pad(value: string, width: number): string {
	const truncated = truncateToWidth(value, width, "…");
	return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}

export function attentionWidgetLines(runs: RunSummary[]): string[] | undefined {
	const counts = new Map<string, number>();
	for (const run of runs) {
		if (!run.requiresAttention) continue;
		counts.set(run.status, (counts.get(run.status) ?? 0) + 1);
	}
	const parts = [
		counts.get("active") ? `${counts.get("active")} active` : undefined,
		counts.get("stopping") ? `${counts.get("stopping")} stopping` : undefined,
		counts.get("interrupted")
			? `${counts.get("interrupted")} interrupted`
			: undefined,
		counts.get("cleanup-blocked")
			? `${counts.get("cleanup-blocked")} cleanup-blocked`
			: undefined,
	].filter((part): part is string => part !== undefined);
	return parts.length ? [`subagents: ${parts.join(" · ")} · alt+s`] : undefined;
}

export function actionsForRun(run: RunSummary): InspectorAction[] {
	const actions: InspectorAction[] = [];
	if (run.status === "active") {
		if (run.controllable) actions.push("steer", "follow-up");
		actions.push("stop");
	}
	if (run.retryable) actions.push("retry");
	if (run.resumable) actions.push("resume");
	if (run.status === "cleanup-blocked") actions.push("reconcile");
	if (run.retainedWorktree && !["active", "stopping"].includes(run.status)) {
		actions.push("release");
	}
	actions.push(run.pinned ? "unpin" : "pin");
	return actions;
}

function labelAction(action: InspectorAction): string {
	return {
		steer: "Steer active run",
		"follow-up": "Queue follow-up",
		stop: "Stop run",
		retry: "Retry in a fresh VM",
		resume: "Resume in a fresh VM",
		reconcile: "Reconcile external state",
		release: "Release retained worktree",
		pin: "Pin run",
		unpin: "Unpin run",
		"export-output": "Export output artifact",
	}[action];
}

function bordered(
	title: string,
	body: string[],
	footer: string[],
	width: number,
	theme: Theme,
): string[] {
	const inner = Math.max(20, width - 2);
	const topLabel = ` ${title} `;
	const top = `┌${topLabel}${"─".repeat(Math.max(0, inner - visibleWidth(topLabel)))}┐`;
	const bottom = `└${"─".repeat(inner)}┘`;
	const line = (value: string) => `│${pad(` ${value}`, inner)}│`;
	return [
		theme.fg("borderAccent", truncateToWidth(top, width, "")),
		...body.map(line),
		...(footer.length > 0
			? [line(""), ...footer.map((value) => line(theme.fg("dim", value)))]
			: []),
		theme.fg("borderAccent", truncateToWidth(bottom, width, "")),
	];
}

function runRows(
	runs: RunSummary[],
	selected: number,
	allProjects: boolean,
	width: number,
	theme: Theme,
): string[] {
	if (runs.length === 0) return [theme.fg("muted", "No matching runs.")];
	const projectWidth = allProjects && width >= 100 ? 18 : 0;
	const statusWidth = 17;
	const ageWidth = 6;
	const workspaceWidth = 3;
	const nameWidth = Math.max(
		12,
		width - statusWidth - ageWidth - workspaceWidth - projectWidth - 10,
	);
	const start = Math.max(0, Math.min(selected, Math.max(0, runs.length - 16)));
	return runs.slice(start, start + 16).map((run, index) => {
		const absoluteIndex = start + index;
		const marker = absoluteIndex === selected ? "›" : " ";
		const status = `${STATUS_ICON[run.status]} ${run.status}`;
		const project = projectWidth
			? ` ${pad(run.repositoryRoot.split("/").at(-1) ?? "", projectWidth)}`
			: "";
		const row = `${marker} ${pad(status, statusWidth)} ${pad(run.agentDisplayName, nameWidth)}${project} ${pad(formatAge(run.updatedAt), ageWidth)} ${run.workspaceMode === "worktree" ? "WT" : "RO"}`;
		return absoluteIndex === selected
			? theme.bg(
					"selectedBg",
					theme.fg("text", truncateToWidth(row, width, "")),
				)
			: theme.fg(
					run.requiresAttention ? "warning" : "text",
					truncateToWidth(row, width, ""),
				);
	});
}

function keyValue(label: string, value: string, width: number): string {
	const labelWidth = Math.min(16, Math.max(10, Math.floor(width / 4)));
	return `${pad(label, labelWidth)} ${truncateToWidth(value, Math.max(1, width - labelWidth - 1))}`;
}

function groupEventsByAttempt(
	inspection: RunInspection,
	logs: RunLogPage | undefined,
): Map<string, RunLogPage["events"]> {
	const groups = new Map<string, RunLogPage["events"]>();
	let currentAttemptId = inspection.attempts[0]?.attemptId;
	for (const event of logs?.events ?? []) {
		if (
			event.type === "attempt-starting" &&
			typeof event.data === "object" &&
			event.data !== null &&
			"attemptId" in event.data &&
			typeof event.data.attemptId === "string"
		) {
			currentAttemptId = event.data.attemptId;
		}
		if (!currentAttemptId) continue;
		const events = groups.get(currentAttemptId) ?? [];
		events.push(event);
		groups.set(currentAttemptId, events);
	}
	return groups;
}

function detailBody(
	inspection: RunInspection,
	logs: RunLogPage | undefined,
	tab: InspectorState["tab"],
	width: number,
	theme: Theme,
): string[] {
	const { summary, plan, result } = inspection;
	const tabLine = TABS.map((candidate) =>
		candidate === tab
			? theme.fg("accent", `[${candidate}]`)
			: theme.fg("muted", candidate),
	).join("  ");
	const lines = [tabLine, ""];
	if (tab === "overview") {
		lines.push(
			keyValue("Goal", summary.goalPreview, width),
			keyValue("Status", summary.status, width),
			keyValue(
				"Controls",
				summary.status === "active"
					? summary.controllable
						? "ready"
						: "session starting"
					: "unavailable",
				width,
			),
			keyValue("Agent", summary.agentDisplayName, width),
			keyValue("Owner", summary.ownerId, width),
			keyValue(
				"Attempt",
				`${inspection.attempts.length} · ${inspection.attempts.at(-1)?.kind ?? "initial"}`,
				width,
			),
			keyValue(
				"Model",
				`${plan.model.provider}/${plan.model.id}:${plan.model.thinking}`,
				width,
			),
			keyValue(
				"Workspace",
				`${summary.workspaceMode}${summary.retainedWorktree ? " · retained" : ""}`,
				width,
			),
			keyValue("Repository", summary.repositoryRoot, width),
			keyValue(
				"Created",
				`${summary.createdAt} · ${formatAge(summary.createdAt)} ago`,
				width,
			),
			keyValue(
				"Updated",
				`${summary.updatedAt} · ${formatAge(summary.updatedAt)} ago`,
				width,
			),
			keyValue(
				"Usage",
				summary.usage
					? `${formatTokens(summary.usage.totalTokens)} tokens · $${summary.usage.cost.toFixed(4)}`
					: "unavailable",
				width,
			),
			keyValue(
				"Retries",
				`${plan.limits.retries} · ${summary.retryable ? "eligible" : "unavailable"}`,
				width,
			),
			keyValue(
				"Resumes",
				`${plan.limits.resumes} · ${summary.resumable ? "eligible" : "unavailable"}`,
				width,
			),
			keyValue("Sandbox", result?.result.sandboxCleanup ?? "pending", width),
			keyValue(
				"Workspace cleanup",
				result?.result.workspaceCleanup ?? "pending",
				width,
			),
			keyValue("Pin", summary.pinned ? "pinned" : "none", width),
		);
	} else if (tab === "activity") {
		const groupedEvents = groupEventsByAttempt(inspection, logs);
		for (const attempt of [...inspection.attempts].reverse()) {
			lines.push(
				theme.fg(
					"accent",
					`Attempt ${attempt.ordinal + 1} · ${attempt.kind} · ${attempt.attemptId}`,
				),
			);
			const attemptEvents = groupedEvents.get(attempt.attemptId) ?? [];
			for (const event of attemptEvents.slice(-8)) {
				lines.push(
					`  ${event.timestamp.slice(11, 19)}  ${event.type.replaceAll("-", " ")}`,
				);
			}
			if (attemptEvents.length === 0)
				lines.push(theme.fg("dim", "  no events"));
			lines.push("");
		}
		if ((logs?.total ?? 0) > (logs?.events.length ?? 0)) {
			lines.push(
				theme.fg(
					"dim",
					`Showing ${logs?.events.length ?? 0} of ${logs?.total ?? 0} events`,
				),
			);
		}
	} else if (tab === "result") {
		if (!result) {
			lines.push(theme.fg("muted", "No terminal result is available."));
		} else {
			lines.push(
				theme.fg("accent", result.error ? "Failure" : "Final output"),
				...(result.error ? [theme.fg("error", result.error), ""] : []),
				...result.output.split("\n").slice(0, 18),
			);
			if (result.result.truncated)
				lines.push(theme.fg("warning", "Output was truncated."));
			if (result.result.output) {
				lines.push(
					"",
					keyValue(
						"Artifact",
						`${result.result.output.sha256} · ${result.result.output.mediaType} · ${result.result.output.bytes} bytes`,
						width,
					),
				);
			}
			if (result.result.structuredOutput !== undefined) {
				lines.push("", theme.fg("accent", "Structured output"));
				lines.push(
					...JSON.stringify(result.result.structuredOutput, null, 2)
						.split("\n")
						.slice(0, 12),
				);
			}
			if (result.handoff?.handoffCommit) {
				lines.push(
					"",
					keyValue("Handoff", result.handoff.handoffCommit, width),
				);
			}
		}
	} else {
		lines.push(
			keyValue("Run ID", summary.runId, width),
			keyValue("Operation ID", plan.operationId, width),
			keyValue("Attempt ID", summary.attemptId, width),
			keyValue("Plan identity", plan.identitySha256, width),
			keyValue("Contract", String(plan.contractRevision), width),
			keyValue("Agent source", plan.agentSource, width),
			keyValue("Agent digest", plan.agentSha256, width),
			keyValue("Context mode", plan.contextMode, width),
			keyValue(
				"Skills",
				`${plan.resources.filter((resource) => resource.kind === "skill").length} discovered · ${plan.preloadSkills.length} preloaded`,
				width,
			),
			keyValue("Context files", plan.contextScopes.join(", ") || "none", width),
			keyValue("Tools", plan.tools.join(", ") || "none", width),
			keyValue("Gondolin", plan.sandbox.packageVersion, width),
			keyValue("Image", plan.sandbox.imageSha256, width),
			keyValue("Mount policy", plan.sandbox.mountPolicySha256, width),
			keyValue("Network policy", plan.sandbox.networkPolicySha256, width),
		);
	}
	return lines.map((line) => truncateToWidth(line, width));
}

export async function showRetentionReport(options: {
	ctx: ExtensionContext;
	report: RetentionReport;
}): Promise<"apply" | "close"> {
	let protectedView = false;
	return options.ctx.ui.custom<"apply" | "close">(
		(tui, theme, _keybindings, done) => ({
			render(width: number) {
				const runs = protectedView
					? options.report.protected
					: options.report.selected;
				const body = [
					`Ordinary retained  ${formatBytes(options.report.ordinaryBytesBefore)}`,
					`Budget             ${formatBytes(options.report.policy.maxBytes)}`,
					`Selected           ${options.report.selected.length} runs`,
					`Protected          ${options.report.protected.length} runs`,
					"",
					...(runs.length
						? runs
								.slice(0, 18)
								.map(
									(run) =>
										`${shortId(run.runId)}  ${pad(run.status, 16)} ${formatAge(run.terminalAt ?? options.report.startedAt)}  ${run.reasons.join(", ")}`,
								)
						: ["No runs in this view."]),
				];
				return bordered(
					`Retention · ${protectedView ? "protected" : "selected"}`,
					body,
					[
						"p selected/protected · a apply · esc back",
						"Applied runs move to recoverable trash.",
					],
					width,
					theme,
				);
			},
			handleInput(data: string) {
				if (matchesKey(data, Key.escape)) done("close");
				else if (data === "a") done("apply");
				else if (data === "p") {
					protectedView = !protectedView;
					tui.requestRender();
				}
			},
			invalidate() {},
		}),
	);
}

export async function showSubagentInspector(options: {
	ctx: ExtensionContext;
	service: SubagentService;
	repositoryRoot?: string;
	initialState?: Partial<InspectorState>;
}): Promise<InspectorIntent> {
	const state: InspectorState = {
		allProjects: options.initialState?.allProjects ?? false,
		view: options.initialState?.view ?? "runs",
		...(options.initialState?.selectedRunId
			? { selectedRunId: options.initialState.selectedRunId }
			: {}),
		tab: options.initialState?.tab ?? "overview",
		...(options.initialState?.search !== undefined
			? { search: options.initialState.search }
			: {}),
		...(options.initialState?.statuses
			? { statuses: options.initialState.statuses }
			: {}),
	};
	let screen: Screen = state.view;
	let runs: RunSummary[] = [];
	let total = 0;
	let nextCursor: string | undefined;
	let selected = 0;
	let inspection: RunInspection | undefined;
	let logs: RunLogPage | undefined;
	let actions: InspectorAction[] = [];
	let actionSelected = 0;
	let pendingAction: InspectorAction | undefined;
	const actionInput = new Input();
	let detailScroll = 0;
	let error: string | undefined;
	let disposed = false;
	let requestRender = () => {};

	const filteredRuns = () => runs;

	const loadRuns = async (append = false) => {
		try {
			const query = {
				...(state.allProjects || !options.repositoryRoot
					? {}
					: { repositoryRoot: options.repositoryRoot }),
				...(state.statuses ? { statuses: state.statuses } : {}),
				...(state.search?.trim() ? { search: state.search.trim() } : {}),
			};
			let page = await options.service.listRuns({
				...query,
				...(append && nextCursor ? { cursor: nextCursor } : {}),
				limit: 50,
			});
			let loaded = append ? [...runs, ...page.runs] : page.runs;
			while (
				!append &&
				state.selectedRunId &&
				!loaded.some((run) => run.runId === state.selectedRunId) &&
				page.nextCursor &&
				loaded.length < 500
			) {
				page = await options.service.listRuns({
					...query,
					cursor: page.nextCursor,
					limit: 50,
				});
				loaded = [...loaded, ...page.runs];
			}
			runs = loaded;
			total = page.total;
			nextCursor = page.nextCursor;
			const visible = filteredRuns();
			const selectedId = state.selectedRunId;
			const selectedIndex = selectedId
				? visible.findIndex((run) => run.runId === selectedId)
				: -1;
			selected =
				selectedIndex >= 0
					? selectedIndex
					: Math.min(selected, Math.max(0, visible.length - 1));
			error = undefined;
		} catch (cause) {
			error = cause instanceof Error ? cause.message : String(cause);
		}
		if (!disposed) requestRender();
	};

	const loadDetail = async (runId: string) => {
		try {
			[inspection, logs] = await Promise.all([
				options.service.inspectRun(runId),
				options.service.runLogs(runId, { tail: 100 }),
			]);
			state.selectedRunId = runId;
			error = undefined;
		} catch (cause) {
			error = cause instanceof Error ? cause.message : String(cause);
		}
		if (!disposed) requestRender();
	};

	await loadRuns();
	if (state.view === "detail" && state.selectedRunId) {
		await loadDetail(state.selectedRunId);
	}

	const unsubscribe = options.service.subscribe((event) => {
		if (disposed) return;
		void loadRuns();
		if (state.selectedRunId === event.runId) void loadDetail(event.runId);
	});
	const clock = setInterval(() => {
		if (!disposed && runs.some((run) => run.status === "active"))
			requestRender();
	}, 1000);
	clock.unref();

	try {
		return await options.ctx.ui.custom<InspectorIntent>(
			(tui, theme, _keybindings, done) => {
				requestRender = () => tui.requestRender();
				const finish = (intent: InspectorIntent) => done(intent);
				actionInput.onSubmit = (text) => {
					if (
						!inspection ||
						!pendingAction ||
						(pendingAction !== "pin" && !text.trim())
					) {
						return;
					}
					finish({
						type: "action",
						action: pendingAction,
						run: inspection.summary,
						state,
						text:
							pendingAction === "pin"
								? text.trim() || "operator pin"
								: text.trim(),
					});
				};
				actionInput.onEscape = () => {
					screen = "actions";
					pendingAction = undefined;
					tui.requestRender();
				};
				return {
					render(width: number) {
						const contentWidth = Math.max(20, width - 4);
						if (screen === "input" && inspection && pendingAction) {
							return bordered(
								`${labelAction(pendingAction)} · ${inspection.summary.agentDisplayName}`,
								[
									pendingAction === "pin" ? "Reason" : "Instruction",
									...actionInput.render(contentWidth),
								],
								["enter submit · esc cancel"],
								width,
								theme,
							);
						}
						if (screen === "confirm" && inspection && pendingAction) {
							const consequences: Partial<Record<InspectorAction, string>> = {
								stop: "The active session will stop and its VM will close.",
								retry:
									"A new attempt and fresh VM will consume remaining budgets.",
								resume: "The retained session will continue in a fresh VM.",
								release: "The verified worktree and branch will be removed.",
							};
							return bordered(
								`Confirm ${pendingAction} · ${inspection.summary.agentDisplayName}`,
								[consequences[pendingAction] ?? "Continue?"],
								["enter confirm · esc cancel"],
								width,
								theme,
							);
						}
						if (screen === "help") {
							return bordered(
								"Subagent inspector help",
								[
									"↑↓       select",
									"enter     inspect/open",
									"escape    back/close",
									"←→        change detail tab",
									"/         search",
									"f         filter",
									"a         current/all projects",
									"g         global actions",
									"r         refresh",
									"space     action palette",
									"?         help",
								],
								["esc back"],
								width,
								theme,
							);
						}
						if (screen === "actions" && inspection) {
							return bordered(
								`Actions · ${inspection.summary.agentDisplayName}`,
								actions.map((action, index) =>
									index === actionSelected
										? theme.bg("selectedBg", `› ${labelAction(action)}`)
										: `  ${labelAction(action)}`,
								),
								["enter select · esc cancel"],
								width,
								theme,
							);
						}
						if (screen === "detail") {
							if (!inspection) {
								return bordered(
									"Subagent run",
									[error ? theme.fg("error", error) : "Loading…"],
									["r refresh · esc back"],
									width,
									theme,
								);
							}
							const detailLines = detailBody(
								inspection,
								logs,
								state.tab,
								contentWidth,
								theme,
							);
							const visibleDetail = detailLines.slice(
								detailScroll,
								detailScroll + 24,
							);
							return bordered(
								`${inspection.summary.agentDisplayName} · ${inspection.summary.status} · ${shortId(inspection.summary.runId)}`,
								visibleDetail,
								[
									`↑↓ scroll ${Math.min(detailLines.length, detailScroll + visibleDetail.length)}/${detailLines.length} · ←→ tabs · space actions`,
									"r refresh · ? help · esc runs",
								],
								width,
								theme,
							);
						}
						const visible = filteredRuns();
						const selectedRun = visible[selected];
						const body = [
							`${runs.filter((run) => run.status === "active").length} active · ${runs.filter((run) => run.requiresAttention && run.status !== "active").length} need attention · ${total} total${state.search ? ` · search: ${state.search}` : ""}`,
							"",
							...runRows(
								visible,
								selected,
								state.allProjects,
								contentWidth,
								theme,
							),
							"",
							...(selectedRun
								? [
										truncateToWidth(selectedRun.goalPreview, contentWidth),
										`${selectedRun.agentDisplayName} · ${shortId(selectedRun.runId)}${selectedRun.pinned ? " · pinned" : ""}`,
									]
								: [
										state.allProjects
											? "No stored runs match this view."
											: "No subagent runs for this project. Press a for all runs.",
									]),
						];
						if (error) body.unshift(theme.fg("error", error), "");
						return bordered(
							`Subagents · ${state.allProjects ? "all projects" : "current project"}`,
							body,
							[
								"enter inspect · / search · f filter · a scope · g global",
								"r refresh · ? help · esc close",
							],
							width,
							theme,
						);
					},
					handleInput(data: string) {
						if (screen === "input") {
							actionInput.handleInput(data);
							tui.requestRender();
							return;
						}
						if (screen === "confirm") {
							if (matchesKey(data, Key.escape)) {
								screen = "actions";
								pendingAction = undefined;
							} else if (
								matchesKey(data, Key.enter) &&
								inspection &&
								pendingAction
							) {
								finish({
									type: "action",
									action: pendingAction,
									run: inspection.summary,
									state,
									confirmed: true,
								});
								return;
							}
							tui.requestRender();
							return;
						}
						if (screen === "help") {
							if (matchesKey(data, Key.escape) || data === "?")
								screen = state.view;
							tui.requestRender();
							return;
						}
						if (screen === "actions") {
							if (matchesKey(data, Key.escape)) {
								screen = "detail";
							} else if (matchesKey(data, Key.up)) {
								actionSelected = Math.max(0, actionSelected - 1);
							} else if (matchesKey(data, Key.down)) {
								actionSelected = Math.min(
									actions.length - 1,
									actionSelected + 1,
								);
							} else if (matchesKey(data, Key.enter) && inspection) {
								const action = actions[actionSelected];
								if (action) {
									pendingAction = action;
									if (["steer", "follow-up", "pin"].includes(action)) {
										actionInput.setValue("");
										screen = "input";
									} else if (
										["stop", "retry", "resume", "release"].includes(action)
									) {
										screen = "confirm";
									} else {
										finish({
											type: "action",
											action,
											run: inspection.summary,
											state,
										});
										return;
									}
								}
							}
							tui.requestRender();
							return;
						}
						if (data === "?") {
							screen = "help";
						} else if (data === "r") {
							void loadRuns();
							if (state.selectedRunId) void loadDetail(state.selectedRunId);
						} else if (screen === "detail") {
							if (matchesKey(data, Key.escape)) {
								screen = "runs";
								state.view = "runs";
								inspection = undefined;
							} else if (
								matchesKey(data, Key.left) ||
								matchesKey(data, Key.right)
							) {
								const index = TABS.indexOf(state.tab);
								const direction = matchesKey(data, Key.left) ? -1 : 1;
								const tab =
									TABS[(index + direction + TABS.length) % TABS.length];
								if (tab) {
									state.tab = tab;
									detailScroll = 0;
								}
							} else if (matchesKey(data, Key.up)) {
								detailScroll = Math.max(0, detailScroll - 1);
							} else if (matchesKey(data, Key.down) && inspection) {
								const length = detailBody(
									inspection,
									logs,
									state.tab,
									80,
									options.ctx.ui.theme,
								).length;
								detailScroll = Math.min(
									Math.max(0, length - 1),
									detailScroll + 1,
								);
							} else if (matchesKey(data, Key.space) && inspection) {
								actions = actionsForRun(inspection.summary);
								if (inspection.result?.result.output) {
									actions.push("export-output");
								}
								actionSelected = 0;
								screen = "actions";
							}
						} else if (matchesKey(data, Key.escape)) {
							finish({ type: "close", state });
							return;
						} else if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
							selected = matchesKey(data, Key.up)
								? Math.max(0, selected - 1)
								: Math.min(filteredRuns().length - 1, selected + 1);
							if (
								matchesKey(data, Key.down) &&
								selected === filteredRuns().length - 1 &&
								nextCursor
							) {
								void loadRuns(true);
							}
							const runId = filteredRuns()[selected]?.runId;
							if (runId) state.selectedRunId = runId;
							else delete state.selectedRunId;
						} else if (matchesKey(data, Key.enter)) {
							const run = filteredRuns()[selected];
							if (run) {
								screen = "detail";
								state.view = "detail";
								detailScroll = 0;
								state.selectedRunId = run.runId;
								void loadDetail(run.runId);
							}
						} else if (data === "a") {
							state.allProjects = !state.allProjects;
							selected = 0;
							delete state.selectedRunId;
							void loadRuns();
						} else if (data === "/") {
							finish({ type: "search", state });
							return;
						} else if (data === "f") {
							finish({ type: "filter", state });
							return;
						} else if (data === "g") {
							finish({ type: "retention", state });
							return;
						}
						tui.requestRender();
					},
					get focused() {
						return actionInput.focused;
					},
					set focused(value: boolean) {
						actionInput.focused = value;
					},
					invalidate() {
						actionInput.invalidate();
					},
				};
			},
		);
	} finally {
		disposed = true;
		unsubscribe();
		clearInterval(clock);
	}
}
