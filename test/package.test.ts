import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

type PackageJson = {
	version?: string;
	private?: boolean;
	main?: string;
	types?: string;
	engines?: { node?: string };
	dependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	exports?: Record<string, unknown>;
	files?: string[];
	pi?: { extensions?: string[]; skills?: string[] };
};

describe("package contract", () => {
	it("pins the qualified Gondolin and Pi lines", async () => {
		const packageJson = JSON.parse(
			await readFile(new URL("../package.json", import.meta.url), "utf8"),
		) as PackageJson;
		expect(packageJson.version).toBe("0.10.0");
		expect(packageJson.private).not.toBe(true);
		expect(packageJson.main).toBe("./dist/index.js");
		expect(packageJson.types).toBe("./dist/index.d.ts");
		expect(packageJson.engines?.node).toBe(">=23.6.0");
		expect(packageJson.dependencies?.["@earendil-works/gondolin"]).toBe(
			"0.12.0",
		);
		expect(
			packageJson.peerDependencies?.["@earendil-works/pi-coding-agent"],
		).toBe(">=0.85.0 <0.86");
		expect(packageJson.exports?.["./extension"]).toEqual({
			types: "./dist/extension.d.ts",
			import: "./dist/extension.js",
		});
		expect(packageJson.exports?.["./service-provider"]).toEqual({
			types: "./dist/service-provider.d.ts",
			import: "./dist/service-provider.js",
		});
		expect(packageJson.pi?.extensions).toEqual(["./dist/extension.js"]);
	});

	it("declares the operating skill to Pi and ships it", async () => {
		const packageJson = JSON.parse(
			await readFile(new URL("../package.json", import.meta.url), "utf8"),
		) as PackageJson;
		expect(packageJson.pi).toEqual({
			extensions: ["./dist/extension.js"],
			skills: ["./skills"],
		});
		expect(packageJson.files).toEqual(
			expect.arrayContaining(["dist", "docs", "skills"]),
		);
		const skill = await readFile(
			new URL("../skills/subagents/SKILL.md", import.meta.url),
			"utf8",
		);
		expect(skill.startsWith("---\nname: subagents\n")).toBe(true);
	});

	it("loads the extension and public module", async () => {
		const extension = await import("../src/extension.js");
		const publicApi = await import("../src/index.js");
		const serviceProvider = await import("../src/service-provider.js");
		expect(extension.default).toBeTypeOf("function");
		expect(publicApi.createVmCapacityManager).toBeTypeOf("function");
		expect(serviceProvider.acquireSubagentService).toBeTypeOf("function");
	}, 30_000);
});
