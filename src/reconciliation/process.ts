import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const QEMU_COMMAND = /(?:^|\/)qemu-system-(?:aarch64|arm|x86_64)(?:\s|$)/;

export type ProcessIdentity = {
	pid: number;
	startedAtMs: number;
	commandSha256: string;
};

export type ProcessObservation =
	| { state: "absent" }
	| { state: "present"; identity: ProcessIdentity }
	| { state: "unknown"; reason: string };

export type ProcessController = {
	observe(pid: number): Promise<ProcessObservation>;
	terminate(identity: ProcessIdentity): Promise<"absent" | "unknown">;
};

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function sameIdentity(left: ProcessIdentity, right: ProcessIdentity): boolean {
	return (
		left.pid === right.pid &&
		left.startedAtMs === right.startedAtMs &&
		left.commandSha256 === right.commandSha256
	);
}

async function wait(milliseconds: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function createHostProcessController(): ProcessController {
	const observe = async (pid: number): Promise<ProcessObservation> => {
		if (!Number.isSafeInteger(pid) || pid < 1) {
			return { state: "unknown", reason: "invalid PID" };
		}
		let stdout: string;
		try {
			({ stdout } = await execFileAsync(
				"ps",
				["-p", String(pid), "-o", "lstart=", "-o", "command="],
				{
					encoding: "utf8",
					timeout: 5_000,
					maxBuffer: 64 * 1024,
				},
			));
		} catch (error) {
			const code = (error as { code?: string | number }).code;
			if (code === 1 || code === "ESRCH") return { state: "absent" };
			return { state: "unknown", reason: "process observation failed" };
		}
		const line = stdout.trim();
		if (!line) return { state: "absent" };
		const match = line.match(
			/^(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/s,
		);
		if (!match)
			return { state: "unknown", reason: "process identity parse failed" };
		const startedAtMs = Date.parse(match[1] ?? "");
		const command = match[2] ?? "";
		if (!Number.isFinite(startedAtMs) || !QEMU_COMMAND.test(command)) {
			return {
				state: "unknown",
				reason: "process is not a qualified QEMU command",
			};
		}
		return {
			state: "present",
			identity: { pid, startedAtMs, commandSha256: digest(command) },
		};
	};

	return {
		observe,
		async terminate(identity) {
			const initial = await observe(identity.pid);
			if (initial.state === "absent") return "absent";
			if (
				initial.state !== "present" ||
				!sameIdentity(initial.identity, identity)
			) {
				return "unknown";
			}
			try {
				process.kill(identity.pid, "SIGTERM");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ESRCH") return "absent";
				return "unknown";
			}
			for (let attempt = 0; attempt < 40; attempt++) {
				await wait(50);
				const current = await observe(identity.pid);
				if (current.state === "absent") return "absent";
				if (
					current.state !== "present" ||
					!sameIdentity(current.identity, identity)
				) {
					return "unknown";
				}
			}
			const beforeKill = await observe(identity.pid);
			if (beforeKill.state === "absent") return "absent";
			if (
				beforeKill.state !== "present" ||
				!sameIdentity(beforeKill.identity, identity)
			) {
				return "unknown";
			}
			try {
				process.kill(identity.pid, "SIGKILL");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ESRCH") return "absent";
				return "unknown";
			}
			for (let attempt = 0; attempt < 40; attempt++) {
				await wait(50);
				if ((await observe(identity.pid)).state === "absent") return "absent";
			}
			return "unknown";
		},
	};
}

export async function captureQemuProcessIdentity(
	pid: number,
	controller: ProcessController = createHostProcessController(),
): Promise<ProcessIdentity> {
	const observation = await controller.observe(pid);
	if (observation.state !== "present") {
		throw new Error(
			`started QEMU process identity is unavailable: ${
				observation.state === "unknown" ? observation.reason : "absent"
			}`,
		);
	}
	return observation.identity;
}

export function processIdentitiesEqual(
	left: ProcessIdentity,
	right: ProcessIdentity,
): boolean {
	return sameIdentity(left, right);
}
