import { createServer } from "node:http";
import { connect } from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";

test("the local E2E boundary loses one accepted response and one stream without creating or changing an upstream task", async () => {
  const projectId = randomUUID(), runId = randomUUID(), key = randomUUID();
  const dir = await mkdtemp("/tmp/pivloom-network-");
  const socketPath = join(dir, "control.sock"), journalPath = join(dir, "journal.jsonl");
  const requests: Array<{ method?: string; path?: string; key?: string }> = [];
  const upstream = createServer((request, response) => {
    requests.push({ method: request.method, path: request.url, key: request.headers["idempotency-key"] as string | undefined });
    if (request.url === "/health") {
      response.end("ready");
    } else if (request.method === "POST") {
      request.resume();
      request.on("end", () => {
        response.writeHead(202, { "content-type": "application/json" });
        response.end(JSON.stringify({ runId, replayed: requests.filter((r) => r.method === "POST").length > 1 }));
      });
    } else {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("id: 7\nevent: run.phase\ndata: {}\n\n");
    }
  });
  await new Promise<void>((done) => upstream.listen(0, "127.0.0.1", done));
  const upstreamAddress = upstream.address();
  if (!upstreamAddress || typeof upstreamAddress === "string") throw new Error("Missing upstream port");
  const reservation = createServer();
  await new Promise<void>((done) => reservation.listen(0, "127.0.0.1", done));
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("Missing proxy port");
  await new Promise<void>((done) => reservation.close(() => done()));
  const child = spawn(process.execPath, ["--import", "tsx", resolve("scripts/validation/network-proxy.ts")], {
    env: { ...process.env, DEV04_PROJECT_ID: projectId, DEV04_PROXY_PORT: String(address.port),
      DEV04_UPSTREAM_PORT: String(upstreamAddress.port), DEV04_CONTROL_PATH: socketPath, DEV04_JOURNAL_PATH: journalPath },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  async function control(action: string) {
    const socket = connect(socketPath);
    socket.setTimeout(2000, () => socket.destroy(new Error("Control timeout")));
    let text = "";
    socket.on("data", (part) => { text += part.toString(); });
    await once(socket, "connect");
    socket.write(JSON.stringify({ action }) + "\n");
    await once(socket, "end");
    return JSON.parse(text) as { ok: boolean; runId?: string; lostAccept: boolean; closedOnce: boolean };
  }
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      new Promise<void>((done, reject) => {
        startupTimer = setTimeout(() => reject(new Error("Proxy startup timeout")), 3000);
        child.stdout.on("data", (part: Buffer) => {
          if (part.toString().includes('"status":"ready"')) { clearTimeout(startupTimer); done(); }
        });
      }),
      exited.then(() => { throw new Error("Proxy exited before ready"); }),
    ]);
    const origin = `http://127.0.0.1:${address.port}`;
    expect(await (await fetch(`${origin}/health`)).text()).toBe("ready");
    expect((await control("lose-next-accept")).ok).toBe(true);
    const options = { method: "POST", body: JSON.stringify({ request: "fixture request" }),
      headers: { "content-type": "application/json", "idempotency-key": key, authorization: "Bearer fixture-private-header" },
      signal: AbortSignal.timeout(2000) };
    await expect(fetch(`${origin}/api/v1/projects/${projectId}/runs`, options)).rejects.toThrow();
    const replay = await fetch(`${origin}/api/v1/projects/${projectId}/runs`, { ...options, signal: AbortSignal.timeout(2000) });
    expect(await replay.json()).toEqual({ runId, replayed: true });
    const stream = await fetch(`${origin}/api/v1/runs/${runId}/events?after=6`, { signal: AbortSignal.timeout(5000) });
    reader = stream.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("id: 7");
    expect(await control("close-sse-once")).toMatchObject({ ok: true, runId, lostAccept: true, closedOnce: true });
    expect((await reader.read()).done).toBe(true);
    expect((await control("close-sse-once")).ok).toBe(false);
    expect(requests.filter((r) => r.method === "POST")).toEqual([
      { method: "POST", path: `/api/v1/projects/${projectId}/runs`, key },
      { method: "POST", path: `/api/v1/projects/${projectId}/runs`, key },
    ]);
    const journal = await readFile(journalPath, "utf8");
    expect(journal).not.toContain("fixture-private-header");
    expect(journal).not.toContain("fixture request");
    const entries = journal.trim().split("\n").map((line) => JSON.parse(line) as { event: string });
    expect(entries.filter((e) => e.event === "accepted_response_lost")).toHaveLength(1);
    expect(entries.filter((e) => e.event === "sse_close_injected")).toHaveLength(1);
    expect(entries.filter((e) => e.event === "stream_requested")).toHaveLength(1);
  } finally {
    clearTimeout(startupTimer);
    await reader?.cancel().catch(() => {});
    if (child.exitCode === null) child.kill("SIGTERM");
    await exited;
    upstream.closeAllConnections();
    await new Promise<void>((done) => upstream.close(() => done()));
    await rm(dir, { recursive: true, force: true });
  }
});
