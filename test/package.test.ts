import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

type PackageJson = {
	engines?: { node?: string };
	dependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	exports?: Record<string, string>;
	pi?: { extensions?: string[] };
};

describe("package contract", () => {
	it("pins the qualified Gondolin and Pi lines", async () => {
		const packageJson = JSON.parse(
			await readFile(new URL("../package.json", import.meta.url), "utf8"),
		) as PackageJson;
		expect(packageJson.engines?.node).toBe(">=23.6.0");
		expect(packageJson.dependencies?.["@earendil-works/gondolin"]).toBe(
			"0.12.0",
		);
		expect(
			packageJson.peerDependencies?.["@earendil-works/pi-coding-agent"],
		).toBe(">=0.84.2 <0.85");
		expect(packageJson.exports?.["./extension"]).toBe("./src/extension.ts");
		expect(packageJson.pi?.extensions).toEqual(["./src/extension.ts"]);
	});

	it("loads the extension and public module", async () => {
		const extension = await import("../src/extension.js");
		const publicApi = await import("../src/index.js");
		expect(extension.default).toBeTypeOf("function");
		expect(publicApi.createVmCapacityManager).toBeTypeOf("function");
	});
});
