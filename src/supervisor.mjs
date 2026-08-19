import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";

const requestPath = process.argv[2];
if (!requestPath) throw new Error("Supervisor request path is required.");
const request = JSON.parse(await readFile(requestPath, "utf8"));
const resultPath = join(request.runDir, "result.json");
const statusPath = join(request.runDir, "status.json");
const stderrPath = join(request.runDir, "stderr.log");

async function writeJsonAtomic(path, value) {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
	await rename(temporary, path);
}

await writeJsonAtomic(statusPath, {
	runId: request.runId,
	status: "launching",
	supervisorPid: process.pid,
});

const args = [
	"--mode",
	"rpc",
	"--session-dir",
	join(request.runDir, "sessions"),
	"--name",
	request.agent,
	"--no-extensions",
	"--no-skills",
	"--no-prompt-templates",
	"--no-themes",
	"--no-context-files",
	"--no-approve",
	"--tools",
	request.tools.join(","),
];
if (request.model) args.push("--model", request.model);
if (request.thinking) args.push("--thinking", request.thinking);

const child = spawn(request.piCommand, args, {
	cwd: request.cwd,
	detached: true,
	stdio: ["pipe", "pipe", "pipe"],
});

let settled = false;
let promptAccepted = false;
let latestOutput = "";
let latestModel = request.model;
let sessionFile;
let stderr = "";
let finished = false;
const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: 0,
	complete: false,
};

function send(command) {
	child.stdin.write(`${JSON.stringify(command)}\n`);
}

async function stopChild(signal = "SIGTERM") {
	try {
		process.kill(-child.pid, signal);
	} catch {}
}

async function finish(status, error) {
	if (finished) return;
	finished = true;
	usage.complete = settled;
	await writeJsonAtomic(resultPath, {
		runId: request.runId,
		status,
		agent: request.agent,
		model: latestModel,
		output: latestOutput,
		...(error ? { error } : {}),
		usage,
		...(sessionFile ? { sessionFile } : {}),
	});
	await writeJsonAtomic(statusPath, {
		runId: request.runId,
		status,
		supervisorPid: process.pid,
		childPid: child.pid,
	});
}

const decoder = new StringDecoder("utf8");
let buffer = "";
function processLine(line) {
	if (!line.trim()) return;
	let event;
	try {
		event = JSON.parse(line);
	} catch {
		stderr += `Non-JSON RPC output: ${line}\n`;
		return;
	}
	if (event.type === "response" && event.id === "state") {
		if (!event.success) {
			void finish("failed", event.error ?? "RPC state preflight failed.");
			void stopChild();
			return;
		}
		sessionFile = event.data?.sessionFile;
		latestModel = event.data?.model
			? `${event.data.model.provider}/${event.data.model.id}`
			: latestModel;
		send({
			id: "prompt",
			type: "prompt",
			message: `You are the Pi subagent named ${JSON.stringify(request.agent)}.\n\nTask:\n${request.task}`,
		});
		return;
	}
	if (event.type === "response" && event.id === "prompt") {
		promptAccepted = Boolean(event.success);
		if (!event.success) {
			void finish("failed", event.error ?? "Prompt was rejected.");
			void stopChild();
		}
		return;
	}
	if (event.type === "message_end" && event.message?.role === "assistant") {
		const text = event.message.content
			?.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("");
		if (text) latestOutput = text;
		if (event.message.model && event.message.provider) {
			latestModel = `${event.message.provider}/${event.message.model}`;
		}
		const reported = event.message.usage;
		if (reported) {
			usage.input += reported.input ?? 0;
			usage.output += reported.output ?? 0;
			usage.cacheRead += reported.cacheRead ?? 0;
			usage.cacheWrite += reported.cacheWrite ?? 0;
			usage.totalTokens += reported.totalTokens ?? 0;
			usage.cost += reported.cost?.total ?? 0;
		}
	}
	if (event.type === "agent_settled") {
		settled = true;
		void finish("completed").then(() => child.stdin.end());
	}
	if (event.type === "extension_error") {
		stderr += `${event.extensionPath ?? "extension"}: ${event.error}\n`;
	}
}

child.stdout.on("data", (chunk) => {
	buffer += decoder.write(chunk);
	while (true) {
		const newline = buffer.indexOf("\n");
		if (newline < 0) break;
		let line = buffer.slice(0, newline);
		buffer = buffer.slice(newline + 1);
		if (line.endsWith("\r")) line = line.slice(0, -1);
		processLine(line);
	}
});
child.stdout.on("end", () => {
	buffer += decoder.end();
	if (buffer) processLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
});
child.stderr.on("data", (chunk) => {
	stderr += chunk.toString();
});
child.once("spawn", async () => {
	await writeJsonAtomic(statusPath, {
		runId: request.runId,
		status: "running",
		supervisorPid: process.pid,
		childPid: child.pid,
	});
	send({ id: "state", type: "get_state" });
});
child.once("error", async (error) => {
	await finish("failed", error.message);
});
child.once("close", async (code, signal) => {
	if (stderr)
		await writeFile(stderrPath, stderr, { encoding: "utf8", mode: 0o600 });
	if (!finished) {
		await finish(
			"failed",
			`Pi RPC child exited before settlement (code=${code ?? "null"}, signal=${signal ?? "null"}, promptAccepted=${promptAccepted}).`,
		);
	}
	process.exitCode = finished && settled ? 0 : 1;
});

const timeout = setTimeout(async () => {
	if (finished) return;
	send({ id: "abort", type: "abort" });
	setTimeout(() => void stopChild("SIGKILL"), 3_000).unref();
	await finish("failed", `Subagent timed out after ${request.timeoutMs}ms.`);
}, request.timeoutMs);
timeout.unref();

process.on("SIGTERM", async () => {
	if (!finished) {
		send({ id: "abort", type: "abort" });
		setTimeout(() => void stopChild("SIGKILL"), 3_000).unref();
		await finish("cancelled", "Subagent was cancelled.");
	}
});
