import { randomUUID } from "node:crypto";
import { createServer, request as httpRequest, type IncomingMessage, type RequestListener } from "node:http";
import type { RequestOptions } from "node:https";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test } from "vitest";
import { createModelFetch } from "../../src/models/transport.js";
import { MODEL_RESPONSE_INTERRUPTED_MESSAGE } from "../../src/models/transport.js";
import { MODEL_RESPONSE_STALLED_MESSAGE } from "../../src/models/transport.js";
import { runBuilder } from "../../src/runtime/pi.js";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/compat";
import type { ProbeEventSink } from "../../src/runtime/types.js";
import { OpenSandboxWorkspace, type SandboxConnection } from "../../src/runtime/workspace.js";
import { PROVIDER_RETRY_POLICY } from "../../src/runtime/budgets.js";

// Real Pi and production fetch; only external DNS/socket and remote sandbox I/O
// are fixtures. No real model, sandbox or application code is executed.

/** Mirror of the SDK backoff: base * 2^(n-1) per attempt, each capped. */
const retryBackoffMs = Array.from({ length: PROVIDER_RETRY_POLICY.maxRetries }, (_, index) =>
  Math.min(PROVIDER_RETRY_POLICY.baseDelayMs * 2 ** index, PROVIDER_RETRY_POLICY.maxAgentDelayMs))
  .reduce((total, delay) => total + delay, 0);
const maxAttempts = PROVIDER_RETRY_POLICY.maxRetries + 1;

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

test("the interrupted-stream error the transport raises is classified as transient by the installed Pi retry policy", () => {
  // Guards the coupling: if a Pi upgrade stops treating premature stream
  // endings as transient, this fails loudly instead of silently losing retries.
  expect(MODEL_RESPONSE_INTERRUPTED_MESSAGE).toContain("MODEL_RESPONSE_INTERRUPTED");
  expect(isRetryableAssistantError({ stopReason: "error", errorMessage: MODEL_RESPONSE_INTERRUPTED_MESSAGE } as never)).toBe(true);
  expect(isRetryableAssistantError({ stopReason: "error", errorMessage: MODEL_RESPONSE_STALLED_MESSAGE } as never)).toBe(true);
});

test("a stream that goes silent without closing is cut by the idle watchdog instead of burning the request budget", async () => {
  const network = await upstream((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(chunk());
    // Never write again and never close: only the watchdog can end this.
  });
  const controller = new AbortController();
  const fetch = createModelFetch("https://model-fixture.invalid/v1", { network, timeoutMs: 30_000, stallTimeoutMs: 300 });
  const startedAt = performance.now();
  await expect(builder(fetch, undefined, controller)).rejects.toMatchObject({
    // A request that never delivers data is reported to the caller as a request
    // timeout, and the detail keeps the static stalled-stream reason.
    code: "MODEL_REQUEST_TIMEOUT", message: expect.stringContaining("MODEL_RESPONSE_STALLED"),
  });
  const elapsed = performance.now() - startedAt;
  // Every attempt is cut at ~300 ms instead of running to the 30 s request
  // deadline, so the whole bounded retry sequence stays close to its backoff.
  expect(elapsed).toBeGreaterThanOrEqual(maxAttempts * 300);
  expect(elapsed).toBeLessThan(maxAttempts * 300 + retryBackoffMs + 5000);
  expect(network.targets).toHaveLength(maxAttempts);
  expect(controller.signal.aborted).toBe(false);
}, 90_000);

test("an HTTP 200 stream disconnected by the upstream is still not reported as a request timeout", async () => {
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
      // Record only the first attempt: later retries legitimately observe the
      // aborted signal of the attempt that already failed.
      signalAbortedBeforeDisconnect ??= network.targets[0].signal?.aborted;
      disconnect?.();
    }
  }, controller)).rejects.toMatchObject({
    code: "MODEL_FAILED", message: expect.stringContaining("MODEL_RESPONSE_INTERRUPTED"),
  });
  expect(controller.signal.aborted).toBe(false);
  expect(network.targets).toHaveLength(maxAttempts);
  expect(signalAbortedBeforeDisconnect).toBe(false);
}, 90_000);

test("a real transport deadline after HTTP 200 stays a bounded timeout and closes every socket it opened", async () => {
  let markClosed!: () => void;
  const closed = new Promise<void>((resolve) => { markClosed = resolve; });
  const network = await upstream((request, response) => {
    request.socket.once("close", markClosed);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(chunk());
  });
  const controller = new AbortController();
  const fetch = createModelFetch("https://model-fixture.invalid/v1", { network, timeoutMs: 1000, stallTimeoutMs: 30_000 });
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
  // A stalled stream is a transient transport failure, so the policy retries it
  // a bounded number of times with exponential backoff instead of failing the
  // whole run on the first drop.
  const elapsed = performance.now() - startedAt;
  expect(elapsed).toBeGreaterThanOrEqual(maxAttempts * 1000 + retryBackoffMs);
  expect(elapsed).toBeLessThan(maxAttempts * 1000 + retryBackoffMs + 3000);
  expect(network.targets).toHaveLength(maxAttempts);
  expect(controller.signal.aborted).toBe(false);
}, 90_000);

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
