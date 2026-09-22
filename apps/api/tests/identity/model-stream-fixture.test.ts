import { randomUUID } from "node:crypto";
import { createServer, request as httpRequest, type IncomingMessage, type RequestListener } from "node:http";
import type { RequestOptions } from "node:https";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test } from "vitest";
import { createModelFetch } from "../../src/models/transport.js";
import { runBuilder } from "../../src/runtime/pi.js";
import type { ProbeEventSink } from "../../src/runtime/types.js";
import { OpenSandboxWorkspace, type SandboxConnection } from "../../src/runtime/workspace.js";

// Real Pi and production fetch; only external DNS/socket and remote sandbox I/O
// are fixtures. No real model, sandbox or application code is executed.
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });

async function upstream(listener: RequestListener) {
  const server = createServer(listener);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => error ? reject(error) : resolve());
  }));
  const port = (server.address() as AddressInfo).port;
  const targets: RequestOptions[] = [];
  return {
    targets,
    lookup: async () => [{ address: "93.184.215.14", family: 4 }],
    request: (options: RequestOptions, listener: (incoming: IncomingMessage) => void) => {
      targets.push(options);
      return httpRequest({ ...options, hostname: "127.0.0.1", port, agent: false }, listener);
    },
  };
}

function chunk() {
  return `data: ${JSON.stringify({ id: "interrupted-response", object: "chat.completion.chunk", created: 1, model: "stream-fixture",
    choices: [{ index: 0, delta: { role: "assistant", content: "已收到部分结果" }, finish_reason: null }] })}\n\n`;
}

async function builder(fetch: typeof globalThis.fetch, onEvent?: ProbeEventSink, controller = new AbortController()) {
  let live = true;
  const connection: SandboxConnection = {
    sandboxId: randomUUID(), kill: async () => { live = false; }, isRunning: async () => live,
    renew: async () => {}, close: async () => {}, read: async () => Buffer.from("fixture source"), write: async () => {},
    endpoint: async () => ({ url: "https://unused.invalid", headers: {} }),
    run: async () => { throw new Error("No remote commands expected in this stream fixture"); },
  };
  const workspace = new OpenSandboxWorkspace({ baseUrl: "http://127.0.0.1:18080", apiKey: "sandbox-fixture", image: "fixture" }, { create: async () => connection });
  const handle = await workspace.create({ runId: randomUUID(), signal: controller.signal });
  try {
    return await runBuilder({ workspace, handle, prompt: "创建一个报名页", signal: controller.signal, onEvent,
      modelConfig: { provider: "stream-fixture", id: "stream-fixture", baseUrl: "https://model-fixture.invalid/v1", api: "openai-completions", apiKey: "model-stream-fixture", fetch } });
  } finally { await workspace.destroy(handle); expect(live).toBe(false); }
}

test("an HTTP 200 stream disconnected by the upstream is not reported as a request timeout", async () => {
  let disconnect: (() => void) | undefined;
  let signalAbortedBeforeDisconnect: boolean | undefined;
  const network = await upstream((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(chunk());
    disconnect = () => response.destroy();
  });
  const controller = new AbortController();
  const fetch = createModelFetch("https://model-fixture.invalid/v1", { network });
  await expect(builder(fetch, (event) => {
    if (event.type === "model.stream.started") {
      signalAbortedBeforeDisconnect = network.targets[0].signal?.aborted;
      disconnect?.();
    }
  }, controller)).rejects.toMatchObject({
    code: "MODEL_FAILED", message: expect.stringContaining("MODEL_RESPONSE_INTERRUPTED"),
  });
  expect(controller.signal.aborted).toBe(false);
  expect(network.targets).toHaveLength(1);
  expect(signalAbortedBeforeDisconnect).toBe(false);
});

test("a real transport deadline after HTTP 200 remains a timeout and closes the socket", async () => {
  let markClosed!: () => void;
  const closed = new Promise<void>((resolve) => { markClosed = resolve; });
  const network = await upstream((request, response) => {
    request.socket.once("close", markClosed);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(chunk());
  });
  const controller = new AbortController();
  const fetch = createModelFetch("https://model-fixture.invalid/v1", { network, timeoutMs: 1000 });
  const startedAt = performance.now();
  let receivedStream = false;
  await expect(builder(fetch, (event) => {
    if (event.type === "model.stream.started") receivedStream = true;
  }, controller)).rejects.toMatchObject({
    code: "MODEL_REQUEST_TIMEOUT", message: expect.stringContaining("MODEL_REQUEST_TIMEOUT"),
  });
  await closed;
  expect(receivedStream).toBe(true);
  expect(controller.signal.aborted).toBe(false);
  expect(performance.now() - startedAt).toBeGreaterThanOrEqual(1000);
  expect(performance.now() - startedAt).toBeLessThan(3000);
  expect(network.targets).toHaveLength(1);
});

test("caller cancellation after actual streamed content remains cancellation", async () => {
  let markClosed!: () => void;
  const closed = new Promise<void>((resolve) => { markClosed = resolve; });
  const network = await upstream((request, response) => {
    request.socket.once("close", markClosed);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(chunk());
  });
  const controller = new AbortController();
  const fetch = createModelFetch("https://model-fixture.invalid/v1", { network });
  await expect(builder(fetch, (event) => {
    if (event.type === "model.stream.started") controller.abort("fixture-cancel");
  }, controller)).rejects.toMatchObject({ code: "CANCELLED" });
  await closed;
  expect(controller.signal.aborted).toBe(true);
  expect(network.targets).toHaveLength(1);
});

test("a completed upstream SSE stream remains a successful Pi response", async () => {
  const network = await upstream((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(chunk());
    response.end(`data: ${JSON.stringify({ id: "interrupted-response", object: "chat.completion.chunk", created: 1, model: "stream-fixture",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  const fetch = createModelFetch("https://model-fixture.invalid/v1", { network });
  const result = await builder(fetch);
  expect(result.text).toBe("已收到部分结果");
  expect(result.usage.modelCalls).toBe(1);
  expect(network.targets).toHaveLength(1);
});
