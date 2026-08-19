import { createHash } from "node:crypto";

function normalize(value: unknown, seen: Set<object>): unknown {
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "boolean"
	) {
		return value;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("non-finite canonical number");
		return Object.is(value, -0) ? 0 : value;
	}
	if (Array.isArray(value)) return value.map((item) => normalize(item, seen));
	if (typeof value !== "object") {
		throw new Error(`non-serializable canonical value: ${typeof value}`);
	}
	if (seen.has(value)) throw new Error("cyclic canonical value");
	seen.add(value);
	try {
		const record = value as Record<string, unknown>;
		const result: Record<string, unknown> = {};
		for (const key of Object.keys(record).sort()) {
			if (record[key] === undefined) {
				throw new Error(`undefined canonical field: ${key}`);
			}
			result[key] = normalize(record[key], seen);
		}
		return result;
	} finally {
		seen.delete(value);
	}
}

export function canonicalJson(value: unknown): string {
	return JSON.stringify(normalize(value, new Set()));
}

export function canonicalSha256(value: unknown): string {
	return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
