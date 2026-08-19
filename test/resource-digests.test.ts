import { randomUUID } from "node:crypto";
import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	digestFileResource,
	digestTreeResource,
	ResourceDigestError,
} from "../src/preflight/resources.js";

function fixture(name: string): string {
	return path.resolve(".pi", "test-resources", `${name}-${randomUUID()}`);
}

describe("resource digests", () => {
	it("digests files with canonical paths and byte counts", async () => {
		const root = fixture("file");
		await mkdir(root, { recursive: true });
		const file = path.join(root, "agent.md");
		await writeFile(file, "agent definition\n");
		const digest = await digestFileResource(file);
		expect(digest.canonicalPath).toBe(file);
		expect(digest.files).toBe(1);
		expect(digest.bytes).toBe(17);
		expect(digest.sha256).toMatch(/^[a-f0-9]{64}$/);
	});

	it("produces deterministic tree identities independent of creation order", async () => {
		const first = fixture("tree-a");
		const second = fixture("tree-b");
		await mkdir(path.join(first, "nested"), { recursive: true });
		await writeFile(path.join(first, "z.txt"), "z");
		await writeFile(path.join(first, "nested", "a.txt"), "a");
		await mkdir(path.join(second, "nested"), { recursive: true });
		await writeFile(path.join(second, "nested", "a.txt"), "a");
		await writeFile(path.join(second, "z.txt"), "z");
		const left = await digestTreeResource(first);
		const right = await digestTreeResource(second);
		expect(left.sha256).toBe(right.sha256);
		expect(left.files).toBe(2);
		expect(left.bytes).toBe(2);
	});

	it("binds content and executable mode", async () => {
		const root = fixture("mode");
		await mkdir(root, { recursive: true });
		const file = path.join(root, "tool.sh");
		await writeFile(file, "echo ok\n");
		const ordinary = await digestTreeResource(root);
		await chmod(file, 0o755);
		const executable = await digestTreeResource(root);
		expect(executable.sha256).not.toBe(ordinary.sha256);
		await writeFile(file, "echo changed\n");
		const changed = await digestTreeResource(root);
		expect(changed.sha256).not.toBe(executable.sha256);
	});

	it("rejects symlinks and bounded-resource overflow", async () => {
		const root = fixture("denied");
		await mkdir(root, { recursive: true });
		await writeFile(path.join(root, "target"), "target");
		await symlink("target", path.join(root, "link"));
		await expect(digestTreeResource(root)).rejects.toBeInstanceOf(
			ResourceDigestError,
		);

		const bounded = fixture("bounded");
		await mkdir(bounded, { recursive: true });
		await writeFile(path.join(bounded, "a"), "a");
		await writeFile(path.join(bounded, "b"), "b");
		await expect(
			digestTreeResource(bounded, { maxFiles: 1, maxBytes: 10 }),
		).rejects.toThrow("resource exceeds file limit");
	});
});
