import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
	SubagentRunRequest,
	SubagentRunResult,
	SupervisorRequest,
} from "./contracts.js";

const SUPERVISOR_PATH = fileURLToPath(
	new URL("./supervisor.mjs", import.meta.url),
);

export function resolvePiCommand(
	environment: NodeJS.ProcessEnv = process.env,
): string {
	return environment.PI_SUBAGENT_BIN ?? "pi";
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
	await rename(temporary, path);
}

export async function runSubagent(
	request: SubagentRunRequest,
	signal?: AbortSignal,
): Promise<SubagentRunResult> {
	const runId = `run_${randomUUID().replaceAll("-", "")}`;
	const runDir = join(getAgentDir(), "subagents", "qualification", runId);
	const requestPath = join(runDir, "request.json");
	const resultPath = join(runDir, "result.json");
	const supervisorRequest: SupervisorRequest = {
		...request,
		runId,
		runDir,
		piCommand: resolvePiCommand(),
	};
	await writeJsonAtomic(requestPath, supervisorRequest);

	const supervisor = spawn(process.execPath, [SUPERVISOR_PATH, requestPath], {
		cwd: resolve(request.cwd),
		detached: true,
		stdio: "ignore",
	});

	const abort = () => supervisor.kill("SIGTERM");
	if (signal?.aborted) abort();
	else signal?.addEventListener("abort", abort, { once: true });

	try {
		const exitCode = await new Promise<number | null>((resolveExit, reject) => {
			supervisor.once("error", reject);
			supervisor.once("close", resolveExit);
		});
		if (!existsSync(resultPath)) {
			throw new Error(
				`Subagent supervisor exited with code ${exitCode ?? "unknown"} without a result (${runId}).`,
			);
		}
		const result = JSON.parse(
			await readFile(resultPath, "utf8"),
		) as SubagentRunResult;
		if (result.status !== "completed") {
			throw new Error(result.error ?? `Subagent ${result.status} (${runId}).`);
		}
		return result;
	} finally {
		signal?.removeEventListener("abort", abort);
	}
}
