import path from "node:path";
import type { VM } from "@earendil-works/gondolin";
import { createLsToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	createGondolinTools,
	GUEST_CACHE_HOME,
	GUEST_WORKSPACE,
	sanitizeGuestEnvironment,
	toGuestPath,
	withToolCallDeadline,
} from "../src/sandbox/tools.js";

describe("Gondolin tool paths", () => {
	const workspace = path.resolve("/tmp/pi-subagent-workspace");

	it("maps relative and host-workspace paths into the guest", () => {
		expect(toGuestPath(workspace, "src/index.ts")).toBe(
			`${GUEST_WORKSPACE}/src/index.ts`,
		);
		expect(toGuestPath(workspace, path.join(workspace, "README.md"))).toBe(
			`${GUEST_WORKSPACE}/README.md`,
		);
		expect(toGuestPath(workspace, path.join(workspace, "..notes"))).toBe(
			`${GUEST_WORKSPACE}/..notes`,
		);
	});

	it("maps source-checkout aliases into a private worktree namespace", () => {
		const mapping = {
			hostWorkspace: "/private/worktrees/attempt",
			hostAliases: ["/Users/example/src/project"],
		};
		expect(
			toGuestPath(mapping, "/Users/example/src/project/src/index.ts"),
		).toBe(`${GUEST_WORKSPACE}/src/index.ts`);
		expect(
			toGuestPath(mapping, "/private/worktrees/attempt/src/index.ts"),
		).toBe(`${GUEST_WORKSPACE}/src/index.ts`);
		expect(toGuestPath(mapping, "/workspace/src/index.ts")).toBe(
			`${GUEST_WORKSPACE}/src/index.ts`,
		);
	});

	it("does not disguise absolute paths outside the workspace", () => {
		expect(toGuestPath(workspace, "/etc/passwd")).toBe("/etc/passwd");
	});

	it("projects only bounded non-secret guest environment values", () => {
		expect(
			sanitizeGuestEnvironment({
				PATH: "/host/bin",
				API_TOKEN: "secret",
				LANG: "en_US.UTF-8",
				LC_ALL: "C",
				TERM: "xterm-256color",
			}),
		).toEqual({
			HOME: "/workspace",
			TMPDIR: "/tmp",
			XDG_CACHE_HOME: "/tmp/cache",
			npm_config_cache: "/tmp/cache/npm",
			YARN_CACHE_FOLDER: "/tmp/cache/yarn",
			PNPM_STORE_DIR: "/tmp/cache/pnpm",
			PIP_CACHE_DIR: "/tmp/cache/pip",
			LANG: "en_US.UTF-8",
			LC_ALL: "C",
			TERM: "xterm-256color",
		});
	});

	it("keeps package-manager caches outside the workspace write budget", () => {
		const environment = sanitizeGuestEnvironment(undefined);
		const cachePaths = [
			environment.XDG_CACHE_HOME,
			environment.npm_config_cache,
			environment.YARN_CACHE_FOLDER,
			environment.PNPM_STORE_DIR,
			environment.PIP_CACHE_DIR,
		];
		expect(cachePaths).toHaveLength(5);
		for (const cachePath of cachePaths) {
			expect(cachePath).toBeTypeOf("string");
			expect(cachePath?.startsWith(`${GUEST_CACHE_HOME}`)).toBe(true);
			expect(cachePath?.startsWith(`${GUEST_WORKSPACE}/`)).toBe(false);
			expect(cachePath).not.toBe(GUEST_WORKSPACE);
			// The budgeted VFS provider only covers the /workspace mount, so a
			// cache under /tmp cannot consume workspaceWriteBytes.
			expect(cachePath?.startsWith("/tmp/")).toBe(true);
		}
		expect(environment.HOME).toBe(GUEST_WORKSPACE);
	});

	it("normalizes leading at signs used by model tool calls", () => {
		expect(toGuestPath(workspace, "@src/index.ts")).toBe(
			`${GUEST_WORKSPACE}/src/index.ts`,
		);
	});
});

type Hang = { calls: string[]; aborted: string[] };

/** A guest call that never settles until its signal is aborted. */
function hang(
	record: Hang,
	name: string,
	signal?: AbortSignal,
): Promise<never> {
	record.calls.push(name);
	return new Promise((_, reject) => {
		signal?.addEventListener(
			"abort",
			() => {
				record.aborted.push(name);
				reject(new Error(`${name} aborted`));
			},
			{ once: true },
		);
	});
}

function hungVm(record: Hang): VM {
	const fs = {
		access: (_path: string, options?: { signal?: AbortSignal }) =>
			hang(record, "access", options?.signal),
		stat: (_path: string, options?: { signal?: AbortSignal }) =>
			hang(record, "stat", options?.signal),
		listDir: (_path: string, options?: { signal?: AbortSignal }) =>
			hang(record, "listDir", options?.signal),
		readFile: (_path: string, options?: { signal?: AbortSignal }) =>
			hang(record, "readFile", options?.signal),
	};
	const exec = (_argv: string[], options?: { signal?: AbortSignal }) => {
		if (!options?.signal) {
			return Promise.resolve({ stdout: "/bin/sh\n", exitCode: 0 });
		}
		const done = hang(record, "exec", options.signal);
		done.catch(() => {});
		return Object.assign(done, {
			output: () => ({
				[Symbol.asyncIterator]: () => ({ next: () => done }),
			}),
		});
	};
	return { fs, exec } as unknown as VM;
}

describe("guest tool call deadline", () => {
	const workspace = path.resolve("/tmp/pi-subagent-workspace");

	it("ends a hung tool call at the bound with an error naming it", async () => {
		let innerSignal: AbortSignal | undefined;
		const tool = withToolCallDeadline(
			{
				...createLsToolDefinition(GUEST_WORKSPACE),
				execute: (_id, _params, signal) => {
					innerSignal = signal;
					return new Promise(() => {});
				},
			},
			50,
		);
		const started = performance.now();
		const result = await tool.execute(
			"call",
			{ path: "." },
			undefined,
			undefined,
			undefined as never,
		);
		expect(performance.now() - started).toBeLessThan(2_000);
		expect(result.isError).toBe(true);
		expect(result.content).toEqual([
			{
				type: "text",
				text: expect.stringContaining("ls tool call exceeded 1s"),
			},
		]);
		expect(innerSignal?.aborted).toBe(true);
	});

	it("stops a hung guest walk at the bound and aborts the guest call", async () => {
		const record: Hang = { calls: [], aborted: [] };
		const tools = await createGondolinTools(hungVm(record), workspace, {
			toolCallDeadlineMs: 50,
		});
		for (const name of ["find", "ls", "grep", "read"] as const) {
			record.calls.length = 0;
			record.aborted.length = 0;
			const parameters =
				name === "find"
					? { pattern: "*.ts", path: "src" }
					: name === "grep"
						? { pattern: "x", path: "src" }
						: { path: "src" };
			const result = await (
				tools[name].execute as (...args: unknown[]) => Promise<{
					isError?: boolean;
					content: unknown;
				}>
			)("call", parameters, undefined, undefined, undefined);
			expect(result.isError).toBe(true);
			expect(JSON.stringify(result.content)).toContain(
				`${name} tool call exceeded 1s`,
			);
			expect(record.calls.length).toBeGreaterThan(0);
			expect(record.aborted).toEqual(record.calls);
		}
	});

	it("refuses a search rooted at the guest's / by name", async () => {
		const record: Hang = { calls: [], aborted: [] };
		const tools = await createGondolinTools(hungVm(record), workspace, {
			toolCallDeadlineMs: 50,
		});
		for (const name of ["find", "ls", "grep"] as const) {
			const parameters =
				name === "ls" ? { path: "/" } : { pattern: "x", path: "/" };
			const result = await (
				tools[name].execute as (...args: unknown[]) => Promise<{
					isError?: boolean;
					content: unknown;
				}>
			)("call", parameters, undefined, undefined, undefined);
			expect(result.isError).toBe(true);
			expect(JSON.stringify(result.content)).toContain(
				`${name} refuses to search from /`,
			);
		}
		expect(record.calls).toEqual([]);
	});

	it("caps a bash timeout at the bound and keeps its expiry fatal", async () => {
		const record: Hang = { calls: [], aborted: [] };
		let closed = 0;
		const tools = await createGondolinTools(hungVm(record), workspace, {
			toolCallDeadlineMs: 50,
			onCommandAbort: async () => {
				closed++;
			},
		});
		expect(tools.bash.description).toContain("at most 1 seconds");
		await expect(
			tools.bash.execute(
				"call",
				{ command: "sleep 600", timeout: 600 },
				undefined,
				undefined,
				undefined as never,
			),
		).rejects.toThrow("Command timed out after 0.05 seconds");
		expect(record.aborted).toEqual(["exec"]);
		expect(closed).toBe(1);
	});
});
