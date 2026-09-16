import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	GUEST_CACHE_HOME,
	GUEST_WORKSPACE,
	sanitizeGuestEnvironment,
	toGuestPath,
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
