import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Vitest rewrites a named import into a property read, so a name Pi stopped
// exporting arrives as `undefined` and only fails on the code path that calls
// it (Node's own loader refuses the module outright). Resolving every named
// value import against the installed Pi packages makes that break visible
// without depending on a test reaching the call site.

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const IMPORT =
	/import\s+(type\s+)?\{([^}]*)\}\s*from\s*"(@earendil-works\/[^"]+)"/g;

type PiImport = { file: string; specifier: string; name: string };

async function sourceFiles(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const files = await Promise.all(
		entries.map((entry) => {
			const full = path.join(directory, entry.name);
			if (entry.isDirectory()) return sourceFiles(full);
			return Promise.resolve(entry.name.endsWith(".ts") ? [full] : []);
		}),
	);
	return files.flat();
}

async function piValueImports(): Promise<PiImport[]> {
	const found: PiImport[] = [];
	for (const file of await sourceFiles(SRC)) {
		const source = await readFile(file, "utf8");
		for (const match of source.matchAll(IMPORT)) {
			const [, typeOnly, names = "", specifier = ""] = match;
			if (typeOnly) continue;
			for (const raw of names.split(",")) {
				const binding = raw.trim();
				if (!binding || binding.startsWith("type ")) continue;
				const name = binding.split(/\s+as\s+/)[0]?.trim() ?? "";
				found.push({ file: path.relative(SRC, file), specifier, name });
			}
		}
	}
	return found;
}

// Loading Pi cold takes seconds; doing it at collection keeps it out of the
// per-test timeout, the same way a static import would.
const imports = await piValueImports();
const modules = new Map<string, Record<string, unknown>>();
for (const specifier of new Set(imports.map((entry) => entry.specifier))) {
	modules.set(specifier, (await import(specifier)) as Record<string, unknown>);
}

describe("Pi package imports", () => {
	it("finds the value imports it guards", () => {
		expect(imports).toContainEqual({
			file: path.join("preflight", "context.ts"),
			specifier: "@earendil-works/pi-coding-agent",
			name: "convertToLlm",
		});
	});

	it("resolves every named value import against the installed Pi", () => {
		const missing = imports
			.filter(
				({ specifier, name }) => modules.get(specifier)?.[name] === undefined,
			)
			.map(({ file, specifier, name }) => `${file}: ${name} from ${specifier}`);
		expect(missing).toEqual([]);
	});
});
