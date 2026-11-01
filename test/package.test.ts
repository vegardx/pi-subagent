import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { GONDOLIN_VERSION } from "../src/sandbox/gondolin.js";

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
	it("records the installed Gondolin version, which is the exact pin", async () => {
		const packageJson = JSON.parse(
			await readFile(new URL("../package.json", import.meta.url), "utf8"),
		) as PackageJson;
		expect(GONDOLIN_VERSION).toBe(
			packageJson.dependencies?.["@earendil-works/gondolin"],
		);
	});

	it("pins the qualified Gondolin and Pi lines", async () => {
		const packageJson = JSON.parse(
			await readFile(new URL("../package.json", import.meta.url), "utf8"),
		) as PackageJson;
		expect(packageJson.version).toBe("0.21.0");
		expect(packageJson.private).not.toBe(true);
		expect(packageJson.main).toBe("./dist/index.js");
		expect(packageJson.types).toBe("./dist/index.d.ts");
		expect(packageJson.engines?.node).toBe(">=23.6.0");
		expect(packageJson.dependencies?.["@earendil-works/gondolin"]).toBe(
			"0.14.0",
		);
		expect(
			packageJson.peerDependencies?.["@earendil-works/pi-coding-agent"],
		).toBe(">=1.4.0 <2");
		expect(packageJson.exports?.["./extension"]).toEqual({
			types: "./dist/extension.d.ts",
			import: "./dist/extension.js",
		});
		expect(packageJson.exports?.["./service-provider"]).toEqual({
			types: "./dist/service-provider.d.ts",
			import: "./dist/service-provider.js",
		});
		expect(packageJson.exports?.["./ceiling-provider"]).toEqual({
			types: "./dist/ceiling-provider.d.ts",
			import: "./dist/ceiling-provider.js",
		});
		expect(packageJson.exports?.["./session-model-provider"]).toEqual({
			types: "./dist/session-model-provider.d.ts",
			import: "./dist/session-model-provider.js",
		});
		expect(packageJson.exports?.["./model-admission-provider"]).toEqual({
			types: "./dist/model-admission-provider.d.ts",
			import: "./dist/model-admission-provider.js",
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
		const ceilingProvider = await import("../src/ceiling-provider.js");
		const sessionModelProvider = await import(
			"../src/session-model-provider.js"
		);
		const modelAdmissionProvider = await import(
			"../src/model-admission-provider.js"
		);
		expect(extension.default).toBeTypeOf("function");
		expect(publicApi.createVmCapacityManager).toBeTypeOf("function");
		expect(serviceProvider.acquireSubagentService).toBeTypeOf("function");
		expect(ceilingProvider.registerDelegationCeilingProvider).toBeTypeOf(
			"function",
		);
		expect(sessionModelProvider.registerSessionModelProvider).toBeTypeOf(
			"function",
		);
		expect(modelAdmissionProvider.registerModelAdmissionProvider).toBeTypeOf(
			"function",
		);
	}, 30_000);
});
