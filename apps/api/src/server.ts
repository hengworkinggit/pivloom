import { createApp } from "./app.js";

const port = Number(process.env.API_PORT ?? 45310);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid API_PORT");
const previewPort = Number(process.env.PREVIEW_PORT ?? 45311);
if (!Number.isInteger(previewPort) || previewPort < 1 || previewPort > 65535) throw new Error("Invalid PREVIEW_PORT");
const app = createApp({ logger: false, previewListen: { host: process.env.PREVIEW_HOST ?? "127.0.0.1", port: previewPort } });
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => { void app.close().then(() => process.exit(0)); });
}
await app.ready();
// Reconcile before the first request can be served: any run a previous process
// left active is marked interrupted and its remote resources are reclaimed.
const recovered = await app.recoverStaleRuns();
await app.listen({ host: process.env.API_HOST ?? "127.0.0.1", port });
console.info(`Pivloom API listening on port ${port}`);
if (recovered) console.info(`Recovered ${recovered} interrupted run(s)`);
