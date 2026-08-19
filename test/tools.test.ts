import path from "node:path";
import { describe, expect, it } from "vitest";
import { GUEST_WORKSPACE, toGuestPath } from "../spike/gondolin/tools.js";

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

	it("does not disguise absolute paths outside the workspace", () => {
		expect(toGuestPath(workspace, "/etc/passwd")).toBe("/etc/passwd");
	});

	it("normalizes leading at signs used by model tool calls", () => {
		expect(toGuestPath(workspace, "@src/index.ts")).toBe(
			`${GUEST_WORKSPACE}/src/index.ts`,
		);
	});
});
