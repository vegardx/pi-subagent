import { createVmCapacityManager } from "../../src/sandbox/capacity.js";

const [root, owner, maxSlotsInput] = process.argv.slice(2);
if (!root || !owner || !maxSlotsInput) {
	throw new Error("usage: capacity-worker <root> <owner> <max-slots>");
}
const manager = await createVmCapacityManager({
	root,
	maxSlots: Number(maxSlotsInput),
});
const lease = await manager.acquire(owner);
process.stdout.write(`${JSON.stringify(lease.record)}\n`);

let releasing = false;
async function releaseAndExit() {
	if (releasing) return;
	releasing = true;
	await lease.release();
	process.exit(0);
}

process.on("SIGTERM", () => void releaseAndExit());
process.on("SIGINT", () => void releaseAndExit());
setInterval(() => {}, 60_000);
