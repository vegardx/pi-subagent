import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHttpHooks, RealFSProvider, VM } from "@earendil-works/gondolin";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	type ModelRuntime,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createGondolinTools, GUEST_WORKSPACE } from "./tools.js";

export type NativeSessionDrive = {
	label: string;
	vmId: string;
	vmHostPid: number | null;
	model: string;
	sessionId: string;
	output: string;
	marker: string;
	resourceCounts: {
		extensions: number;
		skills: number;
		prompts: number;
		themes: number;
		contextFiles: number;
	};
};

function assistantText(messages: readonly unknown[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index] as {
			role?: string;
			content?: Array<{ type?: string; text?: string }>;
		};
		if (message.role !== "assistant" || !Array.isArray(message.content)) {
			continue;
		}
		return message.content
			.filter((part) => part.type === "text")
			.map((part) => part.text ?? "")
			.join("");
	}
	return "";
}

export async function driveNativeSession(options: {
	label: string;
	workspace: string;
	marker: string;
	modelRuntime: ModelRuntime;
	modelId?: string;
}): Promise<NativeSessionDrive> {
	await mkdir(options.workspace, { recursive: true, mode: 0o700 });
	await writeFile(
		path.join(options.workspace, "task.txt"),
		`Write ${options.marker} to result.txt.\n`,
	);
	const { httpHooks } = createHttpHooks({ blockInternalRanges: true });
	const vm = await VM.create({
		sandbox: { vmm: "qemu" },
		memory: "512M",
		cpus: 1,
		rootfs: { mode: "memory" },
		allowWebSockets: false,
		httpHooks,
		dns: { mode: "synthetic" },
		sessionLabel: `pi-subagent native ${options.label}`,
		vfs: {
			mounts: {
				[GUEST_WORKSPACE]: new RealFSProvider(options.workspace),
			},
		},
	});
	let session: AgentSession | undefined;
	try {
		await vm.start();
		const vmHostPid = vm.getHostPid();
		const tools = await createGondolinTools(vm, options.workspace);
		const settingsManager = SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false },
		});
		const resourceLoader = new DefaultResourceLoader({
			cwd: options.workspace,
			agentDir: getAgentDir(),
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPrompt:
				"You are a qualification agent. Use the provided tools to complete the exact task. All tool paths are inside /workspace in a Gondolin VM. Respond with only the requested marker after verifying the file.",
		});
		await resourceLoader.reload();
		const resources = {
			extensions: resourceLoader.getExtensions().extensions.length,
			skills: resourceLoader.getSkills().skills.length,
			prompts: resourceLoader.getPrompts().prompts.length,
			themes: resourceLoader.getThemes().themes.length,
			contextFiles: resourceLoader.getAgentsFiles().agentsFiles.length,
		};
		if (Object.values(resources).some((count) => count !== 0)) {
			throw new Error(`ambient resources leaked: ${JSON.stringify(resources)}`);
		}

		const modelId = options.modelId ?? "gpt-5.6-luna";
		const model = options.modelRuntime.getModel("github-copilot", modelId);
		if (!model) {
			throw new Error(`model unavailable: github-copilot/${modelId}`);
		}

		const created = await createAgentSession({
			cwd: GUEST_WORKSPACE,
			agentDir: getAgentDir(),
			modelRuntime: options.modelRuntime,
			model,
			thinkingLevel: "low",
			noTools: "builtin",
			tools: Object.keys(tools),
			customTools: Object.values(tools).map(
				(tool) => tool as unknown as ToolDefinition,
			),
			resourceLoader,
			sessionManager: SessionManager.inMemory(GUEST_WORKSPACE),
			settingsManager,
		});
		session = created.session;
		await session.prompt(
			`Read task.txt, carry out its instruction, verify result.txt, then respond exactly ${options.marker}`,
		);
		const output = assistantText(session.messages).trim();
		const file = (
			await readFile(path.join(options.workspace, "result.txt"), "utf8")
		).trim();
		if (file !== options.marker) {
			throw new Error(`agent wrote ${JSON.stringify(file)}, expected marker`);
		}
		if (output !== options.marker) {
			throw new Error(
				`agent returned ${JSON.stringify(output)}, expected marker`,
			);
		}
		return {
			label: options.label,
			vmId: vm.id,
			vmHostPid,
			model: `github-copilot/${modelId}`,
			sessionId: session.sessionId,
			output,
			marker: options.marker,
			resourceCounts: resources,
		};
	} finally {
		session?.dispose();
		await vm.close();
	}
}
