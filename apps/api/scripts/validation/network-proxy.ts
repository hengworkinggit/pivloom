/** Local-only HTTP fault boundary for DEV-04 browser E2E. Never imported by the API. */
import { createServer, request as httpRequest, type ServerResponse } from "node:http";
import { createServer as createControlServer } from "node:net";
import { appendFileSync, chmodSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { createHash } from "node:crypto";
import { z } from "zod";

const projectId = z.uuid().parse(process.env.DEV04_PROJECT_ID);
const upstreamPort = z.coerce.number().int().min(1024).max(65535).parse(process.env.DEV04_UPSTREAM_PORT ?? 45314);
const listenPort = z.coerce.number().int().min(1024).max(65535).parse(process.env.DEV04_PROXY_PORT ?? 45310);
if (upstreamPort === listenPort) throw new Error("Proxy must not forward to itself");
const controlPath = resolve(process.env.DEV04_CONTROL_PATH ?? ".cache/development/dev04-network.sock");
const journalPath = resolve(process.env.DEV04_JOURNAL_PATH ?? ".cache/development/dev04-network.jsonl");
if (existsSync(controlPath)) throw new Error("Existing control socket: inspect its owning process before cleanup");
mkdirSync(dirname(controlPath), { recursive: true, mode: 0o700 });
mkdirSync(dirname(journalPath), { recursive: true, mode: 0o700 });
const journal = (event: string, detail: Record<string, unknown> = {}) =>
  appendFileSync(journalPath, JSON.stringify({ at: new Date().toISOString(), event, ...detail }) + "\n", { mode: 0o600 });
let loseAcceptOnce = false;
let lostAccept = false;
let closedOnce = false;
let runId: string | undefined;
let delayReconnectUntil = 0;
let connectionSequence = 0;
const streams = new Map<ServerResponse, { runId: string; connection: number }>();
const server = createServer((incoming, outgoing) => {
  const url = new URL(incoming.url ?? "/", "http://localhost");
  const targetSubmit = incoming.method === "POST" && url.pathname === `/api/v1/projects/${projectId}/runs`;
  const eventRunId = /^\/api\/v1\/runs\/([a-f0-9-]{36})\/events$/.exec(url.pathname)?.[1];
  const connection = eventRunId ? ++connectionSequence : undefined;
  let proxyRequest: ReturnType<typeof httpRequest> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  const bodyHash = createHash("sha256");
  if (targetSubmit) incoming.on("data", (chunk: Buffer) => bodyHash.update(chunk));
  outgoing.on("close", () => {
    clearTimeout(reconnectTimer);
    proxyRequest?.destroy();
    streams.delete(outgoing);
    if (eventRunId && eventRunId === runId) journal("stream_closed", { runId, connection });
  });
  const forward = () => {
    if (outgoing.destroyed) return;
    if (eventRunId && eventRunId === runId) journal("stream_requested", { runId, connection, after: url.searchParams.get("after") ?? "0" });
    proxyRequest = httpRequest({ host: "127.0.0.1", port: upstreamPort, path: incoming.url,
      method: incoming.method, headers: incoming.headers }, (upstream) => {
      if (targetSubmit) {
        const chunks: Buffer[] = [];
        let bytes = 0;
        upstream.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 32 * 1024) { upstream.destroy(); outgoing.destroy(); return; }
          chunks.push(chunk);
        });
        upstream.on("end", () => {
          const body = Buffer.concat(chunks);
          let replayed: boolean | undefined;
          if (upstream.statusCode === 202) {
            const result = z.object({ runId: z.uuid(), replayed: z.boolean() }).parse(JSON.parse(body.toString()));
            runId = result.runId; replayed = result.replayed;
          }
          journal("submit_response", { projectId, runId, status: upstream.statusCode, replayed,
            bodyHash: bodyHash.digest("hex"), idempotencyKey: z.uuid().safeParse(incoming.headers["idempotency-key"]).data });
          if (upstream.statusCode === 202 && loseAcceptOnce && !lostAccept) {
            lostAccept = true; journal("accepted_response_lost", { projectId, runId }); outgoing.destroy(); return;
          }
          outgoing.writeHead(upstream.statusCode ?? 502, upstream.headers); outgoing.end(body);
        });
      } else {
        outgoing.writeHead(upstream.statusCode ?? 502, upstream.headers);
        if (eventRunId && upstream.statusCode === 200) {
          streams.set(outgoing, { runId: eventRunId, connection: connection! });
          outgoing.flushHeaders();
          const decoder = new StringDecoder("utf8");
          let pending = "";
          upstream.on("data", (chunk: Buffer) => {
            if (eventRunId !== runId) return;
            pending += decoder.write(chunk);
            let boundary: number;
            while ((boundary = pending.indexOf("\n\n")) >= 0) {
              const frame = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
              const id = /^id: (\d+)$/m.exec(frame)?.[1];
              const type = /^event: ([a-z.]+)$/m.exec(frame)?.[1];
              if (id) journal("event_forwarded", { runId, connection, id, type });
            }
            if (pending.length > 64 * 1024) { journal("invalid_frame_limit", { runId, connection }); upstream.destroy(); outgoing.destroy(); }
          });
        }
        upstream.pipe(outgoing);
      }
      upstream.on("error", () => outgoing.destroy());
    });
    proxyRequest.on("error", () => {
      if (!outgoing.headersSent) { outgoing.writeHead(502, { "content-type": "application/json" }); outgoing.end('{"error":{"code":"FIXTURE_UPSTREAM_UNAVAILABLE","message":"测试代理暂时无法连接服务。"}}'); }
      else outgoing.destroy();
    });
    incoming.pipe(proxyRequest);
  };
  if (eventRunId && eventRunId === runId && Date.now() < delayReconnectUntil)
    reconnectTimer = setTimeout(forward, delayReconnectUntil - Date.now());
  else forward();
});
const commandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status") }),
  z.object({ action: z.literal("lose-next-accept") }),
  z.object({ action: z.literal("close-sse-once"), reconnectDelayMs: z.number().int().min(0).max(8000).default(0) }),
]);
const control = createControlServer((socket) => {
  let input = "";
  socket.setTimeout(3000, () => socket.destroy());
  socket.on("data", (chunk) => {
    input += chunk.toString();
    if (input.length > 1024) { socket.destroy(); return; }
    if (!input.includes("\n")) return;
    try {
      const command = commandSchema.parse(JSON.parse(input));
      if (command.action === "lose-next-accept") { loseAcceptOnce = true; journal("loss_armed", { projectId }); }
      if (command.action === "close-sse-once") {
        if (closedOnce || !runId) throw new Error("No eligible stream");
        const match = [...streams].find(([, value]) => value.runId === runId);
        if (!match) throw new Error("Target has no live SSE connection");
        closedOnce = true; delayReconnectUntil = Date.now() + command.reconnectDelayMs;
        journal("sse_close_injected", { runId, connection: match[1].connection, reconnectDelayMs: command.reconnectDelayMs });
        match[0].end();
      }
      socket.end(JSON.stringify({ ok: true, projectId, runId, lostAccept, closedOnce,
        activeStreams: [...streams.values()].filter((s) => s.runId === runId) }) + "\n");
    } catch { socket.end('{"ok":false,"message":"Invalid command or no eligible target"}\n'); }
  });
});
await new Promise<void>((resolve) => server.listen(listenPort, "127.0.0.1", resolve));
await new Promise<void>((resolve) => control.listen(controlPath, resolve));
chmodSync(controlPath, 0o600);
journal("proxy_started", { projectId, listenPort, upstreamPort, pid: process.pid });
console.log(JSON.stringify({ status: "ready", projectId, listenPort, upstreamPort, controlPath }));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
  journal("proxy_stopped", { projectId, runId });
  for (const response of streams.keys()) response.destroy();
  server.closeAllConnections(); server.close(); control.close();
  if (existsSync(controlPath)) unlinkSync(controlPath);
  process.exit(0);
});
