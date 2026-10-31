import path from "node:path";
import type { VM } from "@earendil-works/gondolin";
import {
	type BashOperations,
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	DEFAULT_MAX_BYTES,
	type EditOperations,
	type FindOperations,
	formatSize,
	type GrepToolDetails,
	type GrepToolInput,
	type LsOperations,
	type ReadOperations,
	type ToolDefinition,
	truncateHead,
	truncateLine,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent";

import type { TSchema } from "typebox";
import { type WriteBudget, workspaceBudgetNotice } from "./write-budget.js";

export const GUEST_WORKSPACE = "/workspace";
/**
 * Guest cache root. It lives on the attempt's copy-on-write root disk, not in
 * guest memory and not on the workspace mount, so package-manager caches never
 * consume the workspace write budget and never reach the handoff patch. A warm
 * checkpoint holds the same path.
 */
export const GUEST_CACHE_HOME = "/var/cache/pi-subagent";
const DEFAULT_GREP_LIMIT = 100;
/**
 * Wall bound on one guest file tool call. A call that reaches it returns an
 * error result naming the bound, so the model can narrow the call and budget
 * steering still reaches it. `bash` is not bounded here: it keeps its own
 * `timeout` and the attempt deadline, because a bash timeout is fatal to the
 * VM and long builds are legitimate.
 */
export const TOOL_CALL_DEADLINE_MS = 300_000;

type TextToolResult<TDetails> = {
	content: Array<{ type: "text"; text: string }>;
	details: TDetails | undefined;
};

function stripAtPrefix(value: string): string {
	return value.startsWith("@") ? value.slice(1) : value;
}

function toPosix(value: string): string {
	return value.split(path.sep).join(path.posix.sep);
}

function isInsideHostPath(root: string, value: string): boolean {
	const relativePath = path.relative(root, value);
	return (
		relativePath === "" ||
		(relativePath !== ".." &&
			!relativePath.startsWith(`..${path.sep}`) &&
			!path.isAbsolute(relativePath))
	);
}

export type WorkspacePathMap = {
	hostWorkspace: string;
	hostAliases: string[];
};

type WorkspacePathContext = string | WorkspacePathMap;

function hostPathToGuest(hostWorkspace: string, hostPath: string): string {
	const relativePath = path.relative(hostWorkspace, hostPath);
	if (!isInsideHostPath(hostWorkspace, hostPath)) return toPosix(hostPath);
	return relativePath
		? path.posix.join(GUEST_WORKSPACE, toPosix(relativePath))
		: GUEST_WORKSPACE;
}

export function toGuestPath(
	context: WorkspacePathContext,
	inputPath: string,
): string {
	const trimmed = stripAtPrefix(inputPath.trim());
	if (!trimmed) return GUEST_WORKSPACE;
	if (path.isAbsolute(trimmed)) {
		const posixPath = toPosix(trimmed);
		if (
			posixPath === GUEST_WORKSPACE ||
			posixPath.startsWith(`${GUEST_WORKSPACE}/`)
		) {
			return path.posix.resolve("/", posixPath);
		}
		const roots =
			typeof context === "string"
				? [context]
				: [context.hostWorkspace, ...context.hostAliases];
		for (const root of [...new Set(roots)].sort(
			(left, right) => right.length - left.length,
		)) {
			if (isInsideHostPath(root, trimmed))
				return hostPathToGuest(root, trimmed);
		}
		return path.posix.resolve("/", posixPath);
	}
	return path.posix.resolve(GUEST_WORKSPACE, toPosix(trimmed));
}

function createGondolinReadOps(
	vm: VM,
	hostWorkspace: WorkspacePathContext,
	signal?: AbortSignal,
): ReadOperations {
	const options = signal ? { signal } : {};
	return {
		readFile: async (filePath) =>
			vm.fs.readFile(toGuestPath(hostWorkspace, filePath), options),
		access: async (filePath) => {
			await vm.fs.access(toGuestPath(hostWorkspace, filePath), options);
		},
		detectImageMimeType: async (filePath) => {
			const extension = path.posix
				.extname(toGuestPath(hostWorkspace, filePath))
				.toLowerCase();
			if (extension === ".png") return "image/png";
			if (extension === ".jpg" || extension === ".jpeg") {
				return "image/jpeg";
			}
			if (extension === ".gif") return "image/gif";
			if (extension === ".webp") return "image/webp";
			return null;
		},
	};
}

function createGondolinWriteOps(
	vm: VM,
	hostWorkspace: WorkspacePathContext,
): WriteOperations {
	return {
		writeFile: async (filePath, content) => {
			await vm.fs.writeFile(toGuestPath(hostWorkspace, filePath), content, {
				encoding: "utf8",
			});
		},
		mkdir: async (directoryPath) => {
			await vm.fs.mkdir(toGuestPath(hostWorkspace, directoryPath), {
				recursive: true,
			});
		},
	};
}

function createGondolinEditOps(
	vm: VM,
	hostWorkspace: WorkspacePathContext,
): EditOperations {
	const read = createGondolinReadOps(vm, hostWorkspace);
	const write = createGondolinWriteOps(vm, hostWorkspace);
	return {
		readFile: read.readFile,
		writeFile: write.writeFile,
		access: read.access,
	};
}

function createGondolinLsOps(
	vm: VM,
	hostWorkspace: WorkspacePathContext,
	signal?: AbortSignal,
): LsOperations {
	const options = signal ? { signal } : {};
	return {
		exists: async (filePath) => {
			try {
				await vm.fs.access(toGuestPath(hostWorkspace, filePath), options);
				return true;
			} catch {
				signal?.throwIfAborted();
				return false;
			}
		},
		stat: async (filePath) =>
			vm.fs.stat(toGuestPath(hostWorkspace, filePath), options),
		readdir: async (directoryPath) =>
			vm.fs.listDir(toGuestPath(hostWorkspace, directoryPath), options),
	};
}

async function walkGuestFiles(
	vm: VM,
	root: string,
	visit: (guestPath: string, relativePath: string) => Promise<boolean>,
	signal?: AbortSignal,
): Promise<boolean> {
	signal?.throwIfAborted();
	const stat = await vm.fs.stat(root, signal ? { signal } : {});
	if (!stat.isDirectory()) return visit(root, path.posix.basename(root));

	const walkDirectory = async (
		directory: string,
		relativeDirectory: string,
	): Promise<boolean> => {
		signal?.throwIfAborted();
		const entries = await vm.fs.listDir(directory, signal ? { signal } : {});
		for (const entry of entries) {
			if (entry === ".git" || entry === "node_modules") continue;
			const guestPath = path.posix.join(directory, entry);
			const relativePath = relativeDirectory
				? path.posix.join(relativeDirectory, entry)
				: entry;
			let entryStat: Awaited<ReturnType<VM["fs"]["stat"]>>;
			try {
				entryStat = await vm.fs.stat(guestPath, signal ? { signal } : {});
			} catch {
				continue;
			}
			if (entryStat.isDirectory()) {
				if (!(await walkDirectory(guestPath, relativePath))) return false;
			} else if (!(await visit(guestPath, relativePath))) {
				return false;
			}
		}
		return true;
	};

	return walkDirectory(root, "");
}

function matchesToolGlob(relativePath: string, pattern: string): boolean {
	const normalizedPattern = toPosix(pattern);
	if (normalizedPattern.includes("/")) {
		return (
			path.posix.matchesGlob(relativePath, normalizedPattern) ||
			path.posix.matchesGlob(relativePath, `**/${normalizedPattern}`)
		);
	}
	return path.posix.matchesGlob(
		path.posix.basename(relativePath),
		normalizedPattern,
	);
}

function createGondolinFindOps(
	vm: VM,
	hostWorkspace: WorkspacePathContext,
	signal?: AbortSignal,
): FindOperations {
	return {
		exists: async (filePath) => {
			try {
				await vm.fs.access(
					toGuestPath(hostWorkspace, filePath),
					signal ? { signal } : {},
				);
				return true;
			} catch {
				signal?.throwIfAborted();
				return false;
			}
		},
		glob: async (pattern, cwd, options) => {
			const root = toGuestPath(hostWorkspace, cwd);
			const results: string[] = [];
			await walkGuestFiles(
				vm,
				root,
				async (guestPath, relativePath) => {
					if (results.length >= options.limit) return false;
					if (matchesToolGlob(relativePath, pattern)) results.push(guestPath);
					return results.length < options.limit;
				},
				signal,
			);
			return results;
		},
	};
}

type ToolResult<TDetails> = Awaited<
	ReturnType<ToolDefinition<TSchema, TDetails>["execute"]>
>;

function toolError<TDetails>(text: string): ToolResult<TDetails | undefined> {
	return {
		content: [{ type: "text", text }],
		details: undefined,
		isError: true,
	};
}

/**
 * Bounds one tool call at `deadlineMs`. The call's own signal is aborted at the
 * bound so guest filesystem walks stop, and the model receives an error result
 * naming the bound instead of waiting on the attempt deadline. `refuse`
 * rejects a call by name before any guest work starts.
 */
export function withToolCallDeadline<TParams extends TSchema, TDetails>(
	tool: ToolDefinition<TParams, TDetails | undefined>,
	deadlineMs: number,
	refuse?: (params: unknown) => string | undefined,
): ToolDefinition<TParams, TDetails | undefined> {
	const seconds = Math.ceil(deadlineMs / 1000);
	return {
		...tool,
		execute: async (toolCallId, params, signal, onUpdate, context) => {
			const refusal = refuse?.(params);
			if (refusal !== undefined) return toolError<TDetails>(refusal);
			const controller = new AbortController();
			const forward = () => controller.abort(signal?.reason);
			if (signal?.aborted) forward();
			else signal?.addEventListener("abort", forward, { once: true });
			let timer: NodeJS.Timeout | undefined;
			const expired = new Promise<ToolResult<TDetails | undefined>>(
				(resolve) => {
					timer = setTimeout(() => {
						controller.abort(new Error(`tool call exceeded ${seconds}s`));
						resolve(
							toolError<TDetails>(
								`${tool.name} tool call exceeded ${seconds}s and was stopped; narrow the path, pattern, or range and try again`,
							),
						);
					}, deadlineMs);
				},
			);
			try {
				return await Promise.race([
					tool.execute(
						toolCallId,
						params,
						controller.signal,
						onUpdate,
						context,
					),
					expired,
				]);
			} finally {
				clearTimeout(timer);
				signal?.removeEventListener("abort", forward);
			}
		},
	};
}

/**
 * A search rooted at the guest's `/` walks the VM's whole filesystem, `/proc`
 * included, through one guest command per entry; it is refused by name.
 */
function refuseGuestRoot(
	hostWorkspace: WorkspacePathContext,
	toolName: string,
): (params: unknown) => string | undefined {
	return (params) => {
		const requested =
			typeof params === "object" &&
			params !== null &&
			"path" in params &&
			typeof params.path === "string"
				? params.path
				: ".";
		return toGuestPath(hostWorkspace, requested) === "/"
			? `${toolName} refuses to search from /; the repository is ${GUEST_WORKSPACE}, so search it or a specific directory instead`
			: undefined;
	};
}

function createLineMatcher(
	pattern: string,
	literal: boolean | undefined,
	ignoreCase: boolean | undefined,
): (line: string) => boolean {
	if (literal) {
		const needle = ignoreCase ? pattern.toLowerCase() : pattern;
		return (line) => (ignoreCase ? line.toLowerCase() : line).includes(needle);
	}
	const regex = new RegExp(pattern, ignoreCase ? "i" : undefined);
	return (line) => regex.test(line);
}

function appendGrepBlock(parameters: {
	outputLines: string[];
	lines: string[];
	relativePath: string;
	lineIndex: number;
	contextLines: number;
}): boolean {
	let linesTruncated = false;
	const start =
		parameters.contextLines > 0
			? Math.max(0, parameters.lineIndex - parameters.contextLines)
			: parameters.lineIndex;
	const end =
		parameters.contextLines > 0
			? Math.min(
					parameters.lines.length - 1,
					parameters.lineIndex + parameters.contextLines,
				)
			: parameters.lineIndex;

	for (let index = start; index <= end; index++) {
		const rawLine = parameters.lines[index] ?? "";
		const { text, wasTruncated } = truncateLine(rawLine.replace(/\r/g, ""));
		if (wasTruncated) linesTruncated = true;
		const separator = index === parameters.lineIndex ? ":" : "-";
		parameters.outputLines.push(
			`${parameters.relativePath}${separator}${index + 1}${separator} ${text}`,
		);
	}
	return linesTruncated;
}

async function executeGondolinGrep(
	vm: VM,
	hostWorkspace: WorkspacePathContext,
	parameters: GrepToolInput,
	signal?: AbortSignal,
): Promise<TextToolResult<GrepToolDetails>> {
	const root = toGuestPath(hostWorkspace, parameters.path ?? ".");
	const rootStat = await vm.fs.stat(root, signal ? { signal } : {});
	const rootIsDirectory = rootStat.isDirectory();
	const matcher = createLineMatcher(
		parameters.pattern,
		parameters.literal,
		parameters.ignoreCase,
	);
	const contextLines =
		parameters.context && parameters.context > 0 ? parameters.context : 0;
	const effectiveLimit = Math.max(1, parameters.limit ?? DEFAULT_GREP_LIMIT);
	const outputLines: string[] = [];
	const details: GrepToolDetails = {};
	let matchCount = 0;
	let matchLimitReached = false;
	let linesTruncated = false;

	await walkGuestFiles(
		vm,
		root,
		async (guestPath, relativePath) => {
			if (matchCount >= effectiveLimit) return false;
			if (parameters.glob && !matchesToolGlob(relativePath, parameters.glob)) {
				return true;
			}
			let content: string;
			try {
				content = await vm.fs.readFile(guestPath, {
					encoding: "utf8",
					...(signal ? { signal } : {}),
				});
			} catch {
				return true;
			}
			const lines = content
				.replace(/\r\n/g, "\n")
				.replace(/\r/g, "\n")
				.split("\n");
			const displayPath = rootIsDirectory
				? relativePath
				: path.posix.basename(guestPath);
			for (let index = 0; index < lines.length; index++) {
				signal?.throwIfAborted();
				if (!matcher(lines[index] ?? "")) continue;
				matchCount++;
				if (
					appendGrepBlock({
						outputLines,
						lines,
						relativePath: displayPath,
						lineIndex: index,
						contextLines,
					})
				) {
					linesTruncated = true;
				}
				if (matchCount >= effectiveLimit) {
					matchLimitReached = true;
					return false;
				}
			}
			return true;
		},
		signal,
	);

	if (matchCount === 0) {
		return {
			content: [{ type: "text", text: "No matches found" }],
			details: undefined,
		};
	}

	const truncation = truncateHead(outputLines.join("\n"), {
		maxLines: Number.MAX_SAFE_INTEGER,
	});
	const notices: string[] = [];
	let output = truncation.content;
	if (matchLimitReached) {
		details.matchLimitReached = effectiveLimit;
		notices.push(`${effectiveLimit} matches limit reached`);
	}
	if (linesTruncated) {
		details.linesTruncated = true;
		notices.push("long lines truncated");
	}
	if (truncation.truncated) {
		details.truncation = truncation;
		notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
	}
	if (notices.length > 0) output += `\n\n[${notices.join(". ")}.]`;

	return {
		content: [{ type: "text", text: output }],
		details: Object.keys(details).length > 0 ? details : undefined,
	};
}

export function sanitizeGuestEnvironment(
	environment: NodeJS.ProcessEnv | undefined,
): Record<string, string> {
	const result: Record<string, string> = {
		HOME: GUEST_WORKSPACE,
		TMPDIR: "/tmp",
		XDG_CACHE_HOME: GUEST_CACHE_HOME,
		npm_config_cache: `${GUEST_CACHE_HOME}/npm`,
		YARN_CACHE_FOLDER: `${GUEST_CACHE_HOME}/yarn`,
		PNPM_STORE_DIR: `${GUEST_CACHE_HOME}/pnpm`,
		PIP_CACHE_DIR: `${GUEST_CACHE_HOME}/pip`,
	};
	if (!environment) return result;
	for (const [key, value] of Object.entries(environment)) {
		if (
			typeof value === "string" &&
			value.length <= 4096 &&
			(key === "LANG" ||
				key === "TERM" ||
				key === "COLORTERM" ||
				key === "NO_COLOR" ||
				key === "FORCE_COLOR" ||
				key.startsWith("LC_"))
		) {
			result[key] = value;
		}
	}
	return result;
}

function createGondolinBashOps(
	vm: VM,
	hostWorkspace: WorkspacePathContext,
	shellPath: string,
	onCommandAbort?: () => Promise<void>,
	writeBudget?: WriteBudget,
): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout, env }) => {
			signal?.throwIfAborted();
			const refusalsBefore = writeBudget?.refusals ?? 0;
			const reportBudgetRefusals = () => {
				if (!writeBudget) return;
				if (writeBudget.refusals <= refusalsBefore) return;
				onData(
					Buffer.from(`\n${workspaceBudgetNotice(writeBudget)}\n`, "utf8"),
				);
			};
			const guestCwd = toGuestPath(hostWorkspace, cwd);
			const controller = new AbortController();
			const onAbort = () => controller.abort();
			signal?.addEventListener("abort", onAbort, { once: true });

			let timedOut = false;
			const timer =
				timeout && timeout > 0
					? setTimeout(() => {
							timedOut = true;
							controller.abort();
						}, timeout * 1000)
					: undefined;

			try {
				const sanitizedEnvironment = sanitizeGuestEnvironment(env);
				const process = vm.exec([shellPath, "-lc", command], {
					cwd: guestCwd,
					env: sanitizedEnvironment,
					signal: controller.signal,
					stdout: "pipe",
					stderr: "pipe",
				});
				for await (const chunk of process.output()) onData(chunk.data);
				const result = await process;
				reportBudgetRefusals();
				return { exitCode: result.exitCode };
			} catch (error) {
				reportBudgetRefusals();
				if (signal?.aborted || timedOut) {
					try {
						await onCommandAbort?.();
					} catch (cleanupError) {
						throw new AggregateError(
							[error, cleanupError],
							"command abort did not prove VM cleanup",
						);
					}
				}
				if (signal?.aborted) throw new Error("aborted");
				if (timedOut) throw new Error(`timeout:${timeout}`);
				throw error;
			} finally {
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
			}
		},
	};
}

type GondolinTools = {
	read: ReturnType<typeof createReadToolDefinition>;
	write: ReturnType<typeof createWriteToolDefinition>;
	edit: ReturnType<typeof createEditToolDefinition>;
	bash: ReturnType<typeof createBashToolDefinition>;
	grep: ReturnType<typeof createGrepToolDefinition>;
	find: ReturnType<typeof createFindToolDefinition>;
	ls: ReturnType<typeof createLsToolDefinition>;
};

export async function createGondolinTools(
	vm: VM,
	hostWorkspace: WorkspacePathContext,
	options: {
		onCommandAbort?: () => Promise<void>;
		writeBudget?: WriteBudget;
		/** Lowered by tests; production runs at `TOOL_CALL_DEADLINE_MS`. */
		toolCallDeadlineMs?: number;
	} = {},
): Promise<GondolinTools> {
	const deadlineMs = options.toolCallDeadlineMs ?? TOOL_CALL_DEADLINE_MS;
	const shellProbe = await vm.exec([
		"/bin/sh",
		"-lc",
		"command -v bash || true",
	]);
	const shellPath = shellProbe.stdout.trim() || "/bin/sh";
	// Read, ls, and find bind their guest operations to each call's signal, so
	// the deadline stops the guest work rather than only the wait for it.
	const readTemplate = createReadToolDefinition(GUEST_WORKSPACE);
	const read = withToolCallDeadline(
		{
			...readTemplate,
			execute: (toolCallId, params, signal, onUpdate, context) =>
				createReadToolDefinition(GUEST_WORKSPACE, {
					operations: createGondolinReadOps(vm, hostWorkspace, signal),
				}).execute(toolCallId, params, signal, onUpdate, context),
		},
		deadlineMs,
	);
	const write = withToolCallDeadline(
		createWriteToolDefinition(GUEST_WORKSPACE, {
			operations: createGondolinWriteOps(vm, hostWorkspace),
		}),
		deadlineMs,
	);
	const edit = withToolCallDeadline(
		createEditToolDefinition(GUEST_WORKSPACE, {
			operations: createGondolinEditOps(vm, hostWorkspace),
		}),
		deadlineMs,
	);
	const bash = createBashToolDefinition(GUEST_WORKSPACE, {
		operations: createGondolinBashOps(
			vm,
			hostWorkspace,
			shellPath,
			options.onCommandAbort,
			options.writeBudget,
		),
		exposeSessionEnvironment: false,
	});
	const lsTemplate = createLsToolDefinition(GUEST_WORKSPACE);
	const ls = withToolCallDeadline(
		{
			...lsTemplate,
			execute: (toolCallId, params, signal, onUpdate, context) =>
				createLsToolDefinition(GUEST_WORKSPACE, {
					operations: createGondolinLsOps(vm, hostWorkspace, signal),
				}).execute(toolCallId, params, signal, onUpdate, context),
		},
		deadlineMs,
		refuseGuestRoot(hostWorkspace, "ls"),
	);
	const findTemplate = createFindToolDefinition(GUEST_WORKSPACE);
	const find = withToolCallDeadline(
		{
			...findTemplate,
			execute: (toolCallId, params, signal, onUpdate, context) =>
				createFindToolDefinition(GUEST_WORKSPACE, {
					operations: createGondolinFindOps(vm, hostWorkspace, signal),
				}).execute(toolCallId, params, signal, onUpdate, context),
		},
		deadlineMs,
		refuseGuestRoot(hostWorkspace, "find"),
	);
	const localGrep = createGrepToolDefinition(GUEST_WORKSPACE);
	const grep = withToolCallDeadline(
		{
			...localGrep,
			execute: async (_id, parameters, signal) =>
				executeGondolinGrep(vm, hostWorkspace, parameters, signal),
		},
		deadlineMs,
		refuseGuestRoot(hostWorkspace, "grep"),
	);

	return { read, write, edit, bash, grep, find, ls };
}
