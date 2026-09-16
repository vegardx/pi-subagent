import {
	SandboxVfsProvider,
	type VfsHookContext,
	type VirtualProvider,
} from "@earendil-works/gondolin";

/**
 * Linux `EDQUOT`. The guest interprets filesystem RPC errno numbers as Linux
 * values, so a budget refusal is reported as a disk-quota failure instead of
 * the generic `EIO` an untyped hook error would produce.
 */
const EDQUOT = 122;

export const WORKSPACE_BUDGET_ERRNO_CODE = "EDQUOT";

export type WriteBudget = {
	readonly limitBytes: number;
	readonly reservedBytes: number;
	readonly remainingBytes: number;
	readonly exhausted: boolean;
	readonly refusals: number;
};

export class WorkspaceWriteBudgetError extends Error {
	readonly code = WORKSPACE_BUDGET_ERRNO_CODE;
	readonly errno = EDQUOT;
	readonly requestedBytes: number;
	readonly remainingBytes: number;
	readonly limitBytes: number;

	constructor(options: {
		requestedBytes: number;
		remainingBytes: number;
		limitBytes: number;
		path?: string;
	}) {
		super(
			`workspace write budget exceeded: requested=${options.requestedBytes} remaining=${options.remainingBytes} limit=${options.limitBytes}${
				options.path ? ` path=${options.path}` : ""
			}`,
		);
		this.name = "WorkspaceWriteBudgetError";
		this.requestedBytes = options.requestedBytes;
		this.remainingBytes = options.remainingBytes;
		this.limitBytes = options.limitBytes;
	}
}

/** Operator- and model-facing notice for refused guest writes. */
export function workspaceBudgetNotice(budget: WriteBudget): string {
	return `pi-subagent: workspace write budget exhausted (limit=${budget.limitBytes} bytes, reserved=${budget.reservedBytes} bytes, refusals=${budget.refusals}). Writes under /workspace now fail with EDQUOT (Disk quota exceeded); this is a budget refusal, not a disk failure. Package caches belong under $XDG_CACHE_HOME, outside /workspace.`;
}

function operationBytes(context: VfsHookContext): number {
	if (context.op === "write") return context.length ?? 0;
	if (context.op === "writeFile") return context.data?.byteLength ?? 0;
	if (context.op === "truncate") return context.size ?? 0;
	return 0;
}

export function withWriteBudget(
	provider: VirtualProvider,
	limitBytes: number,
): { provider: VirtualProvider; budget: WriteBudget } {
	if (!Number.isSafeInteger(limitBytes) || limitBytes < 0) {
		throw new Error("write budget must be a non-negative safe integer");
	}
	let reservedBytes = 0;
	let refusals = 0;
	const budget: WriteBudget = {
		get limitBytes() {
			return limitBytes;
		},
		get reservedBytes() {
			return reservedBytes;
		},
		get remainingBytes() {
			return limitBytes - reservedBytes;
		},
		get exhausted() {
			return refusals > 0;
		},
		get refusals() {
			return refusals;
		},
	};
	return {
		budget,
		provider: new SandboxVfsProvider(provider, {
			before(context) {
				const bytes = operationBytes(context);
				if (bytes === 0) return;
				if (bytes > limitBytes - reservedBytes) {
					refusals += 1;
					throw new WorkspaceWriteBudgetError({
						requestedBytes: bytes,
						remainingBytes: limitBytes - reservedBytes,
						limitBytes,
						...(context.path ? { path: context.path } : {}),
					});
				}
				reservedBytes += bytes;
			},
		}) as unknown as VirtualProvider,
	};
}
