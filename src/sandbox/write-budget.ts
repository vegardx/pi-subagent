import {
	SandboxVfsProvider,
	type VfsHookContext,
	type VirtualProvider,
} from "@earendil-works/gondolin";

export type WriteBudget = {
	readonly limitBytes: number;
	readonly reservedBytes: number;
	readonly remainingBytes: number;
};

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
	};
	return {
		budget,
		provider: new SandboxVfsProvider(provider, {
			before(context) {
				const bytes = operationBytes(context);
				if (bytes === 0) return;
				if (bytes > limitBytes - reservedBytes) {
					throw new Error(
						`workspace write budget exceeded: requested=${bytes} remaining=${limitBytes - reservedBytes} limit=${limitBytes}`,
					);
				}
				reservedBytes += bytes;
			},
		}) as unknown as VirtualProvider,
	};
}
