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
	pi?: { extensions?: string[] };
};

describe("package contract", () => {
	it("pins the qualified Gondolin and Pi lines", async () => {
		const packageJson = JSON.parse(
			await readFile(new URL("../package.json", import.meta.url), "utf8"),
		) as PackageJson;
		expect(packageJson.version).toBe("0.9.0");
		expect(packageJson.private).not.toBe(true);
		expect(packageJson.main).toBe("./dist/index.js");
		expect(packageJson.types).toBe("./dist/index.d.ts");
		expect(packageJson.engines?.node).toBe(">=23.6.0");
		expect(packageJson.dependencies?.["@earendil-works/gondolin"]).toBe(
			"0.12.0",
		);
		expect(
			packageJson.peerDependencies?.["@earendil-works/pi-coding-agent"],
		).toBe(">=0.84.2 <0.85");
		expect(packageJson.exports?.["./extension"]).toEqual({
			types: "./dist/extension.d.ts",
			import: "./dist/extension.js",
		});
		expect(packageJson.pi?.extensions).toEqual(["./dist/extension.js"]);
	});

	it("loads the extension and public module", async () => {
		const extension = await import("../src/extension.js");
		const publicApi = await import("../src/index.js");
		expect(extension.default).toBeTypeOf("function");
		expect(publicApi.createVmCapacityManager).toBeTypeOf("function");
	}, 15_000);
});
