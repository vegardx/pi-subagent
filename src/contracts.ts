export interface SubagentRunRequest {
	agent: string;
	task: string;
	cwd: string;
	model?: string;
	thinking?: string;
	tools: string[];
	timeoutMs: number;
}

export interface SubagentUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
	complete: boolean;
}

export interface SubagentRunResult {
	runId: string;
	status: "completed" | "failed" | "cancelled";
	agent: string;
	model?: string;
	output: string;
	error?: string;
	usage: SubagentUsage;
	sessionFile?: string;
}

export interface SupervisorRequest extends SubagentRunRequest {
	runId: string;
	runDir: string;
	piCommand: string;
}
