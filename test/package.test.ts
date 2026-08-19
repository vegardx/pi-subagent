import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));

describe("package manifest", () => {
	it("loads one extension entry", () => {
		expect(pkg.pi.extensions).toEqual(["./src/extension.ts"]);
	});

	it("keeps Pi packages as peers", () => {
		expect(pkg.peerDependencies).toMatchObject({
			"@earendil-works/pi-ai": ">=0.84.2 <0.85",
			"@earendil-works/pi-coding-agent": ">=0.84.2 <0.85",
			"@earendil-works/pi-tui": ">=0.84.2 <0.85",
			typebox: "*",
		});
	});
});
