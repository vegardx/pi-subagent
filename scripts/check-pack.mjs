import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const { stdout } = await execFileAsync("npm", ["pack", "--dry-run", "--json"], {
	encoding: "utf8",
	maxBuffer: 8 * 1024 * 1024,
});
const [result] = JSON.parse(stdout);
if (!result || !Array.isArray(result.files)) {
	throw new Error("npm pack did not return a file manifest");
}
const paths = new Set(result.files.map((file) => file.path));
for (const required of [
	"LICENSE",
	"LICENSES/Apache-2.0.txt",
	"README.md",
	"THIRD_PARTY_NOTICES.md",
	"dist/extension.d.ts",
	"dist/extension.js",
	"dist/index.d.ts",
	"dist/index.js",
	"package.json",
]) {
	if (!paths.has(required)) throw new Error(`packed file missing: ${required}`);
}
for (const filePath of paths) {
	if (
		filePath.startsWith("src/") ||
		filePath.startsWith("spike/") ||
		filePath.startsWith("test/")
	) {
		throw new Error(`development source leaked into package: ${filePath}`);
	}
}
if (result.entryCount > 200 || result.unpackedSize > 2 * 1024 * 1024) {
	throw new Error("packed package exceeds release bounds");
}
