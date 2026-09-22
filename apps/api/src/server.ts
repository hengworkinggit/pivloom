import { createApp } from "./app.js";

const port = Number(process.env.API_PORT ?? 45310);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid API_PORT");
const app = createApp({ logger: false });
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => { void app.close().then(() => process.exit(0)); });
}
await app.listen({ host: process.env.API_HOST ?? "127.0.0.1", port });
console.info(`Pivloom API listening on port ${port}`);
