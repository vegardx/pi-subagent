import { acquireRunLease } from "../../src/persistence/run-lease.js";

const [root, runId] = process.argv.slice(2);
if (!root || !runId) throw new Error("usage: run-lease-worker <root> <run-id>");
const lease = await acquireRunLease({ root, runId });
process.stdout.write(`${JSON.stringify(lease.record)}\n`);
process.on("SIGTERM", () => void lease.release().then(() => process.exit(0)));
setInterval(() => {}, 60_000);
