import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { runBuilder } from "../../src/runtime/pi.js";
import { OpenSandboxWorkspace, type SandboxConnection } from "../../src/runtime/workspace.js";
import type { ProbeEvent, ProbeEventSink } from "../../src/runtime/types.js";

// Only model HTTP responses and remote process/file I/O are fixtures. The Pi
// session, tool adapters, output limits and event ordering run unchanged.
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const modelKey = "private-model-fixture-key";
const sandboxKey = "private-sandbox-fixture-key";
type ToolStep = { name: string; arguments: Record<string, unknown> };

async function builderFixture(options: {
  steps?: ToolStep[];
  shell?: (output: (chunk: string) => void) => Promise<void>;
  onEvent?: ProbeEventSink;
  controller?: AbortController;
}) {
  const events: ProbeEvent[] = [];
  const files = new Map<string, Buffer>();
  let live = true, request = 0;
  const steps = options.steps ?? [{ name: "bash", arguments: { command: "fixture-command" } }];
  const connection: SandboxConnection = {
    sandboxId: randomUUID(),
    kill: async () => { live = false; }, isRunning: async () => live,
    renew: async () => {}, close: async () => {},
    read: async (path) => files.get(path) ?? Buffer.alloc(0),
    write: async (path, data) => { files.set(path, Buffer.from(data)); },
    endpoint: async () => ({ url: "https://unused.invalid", headers: {} }),
    run: async (command, remoteOptions) => ({
      id: randomUUID(), interrupt: async () => {},
      wait: async () => {
        let stdoutTail = "";
        if (command === "fixture-command") {
          await options.shell?.((chunk) => { remoteOptions.onOutput?.(chunk); stdoutTail = (stdoutTail + chunk).slice(-16000); });
        } else if (command.startsWith("node /opt/pivloom/source-io.mjs")) {
          const input = JSON.parse(files.get(command.split("'")[1])!.toString()) as { op: string; path: string; data: string };
          if (input.op === "write") { files.set(input.path, Buffer.from(input.data, "base64")); stdoutTail = '{"ok":true}'; }
          if (input.op === "read") stdoutTail = JSON.stringify({ data: files.get(input.path)!.toString("base64") });
        }
        return { exitCode: 0, stdoutTail, stderrTail: "" };
      },
    }),
  };
  const workspace = new OpenSandboxWorkspace({ baseUrl: "http://127.0.0.1:18080", apiKey: sandboxKey, image: "fixture" }, { create: async () => connection });
  const controller = options.controller ?? new AbortController();
  const handle = await workspace.create({ runId: randomUUID(), signal: controller.signal });
  const fetch: typeof globalThis.fetch = async () => {
    const step = steps[request++];
    const delta = step ? { role: "assistant", reasoning_content: "HIDDEN_REASONING_NEVER_PUBLIC", tool_calls: [{ index: 0, id: `fixture-tool-${request}`, type: "function", function: { name: step.name, arguments: JSON.stringify(step.arguments) } }] } : { role: "assistant", content: "已完成。" };
    const event = { id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: null }] };
    return new Response(`data: ${JSON.stringify(event)}\n\ndata: ${JSON.stringify({ ...event, choices: [{ index: 0, delta: {}, finish_reason: step ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
  };
  try {
    const result = await runBuilder({
      workspace, handle, prompt: "执行远程工具并汇报必要结果。", signal: controller.signal,
      modelConfig: { provider: "fixture", id: "fixture", api: "openai-completions", baseUrl: "https://model.invalid/v1", apiKey: modelKey, fetch },
      redactValues: [sandboxKey],
      onEvent: async (event) => { events.push(event); await options.onEvent?.(event); },
    });
    return { result, events, isLive: () => live };
  } finally { await workspace.destroy(handle); }
}

test("remote shell output is visible within a batch interval and is flushed before tool completion", async () => {
  const observed: ProbeEvent[] = [];
  const { events } = await builderFixture({
    onEvent: (event) => { observed.push(event); },
    shell: async (output) => {
      output("第一段真实命令输出\n");
      await delay(330);
      expect(observed.some((event) => event.type === "tool.output" && event.message.includes("第一段"))).toBe(true);
      expect(observed.some((event) => event.type === "tool.end")).toBe(false);
      output("第二段真实命令输出\n");
    },
  });
  const logs = events.filter((event) => event.type === "tool.output");
  expect(logs.map((event) => event.message).join("")).toContain("第一段真实命令输出\n第二段真实命令输出\n");
  expect(logs.every((event) => event.toolName === "bash" && event.toolCallId === "fixture-tool-1")).toBe(true);
  expect(events.indexOf(logs[logs.length - 1])).toBeLessThan(events.findIndex((event) => event.type === "tool.end"));
  expect(JSON.stringify(events)).not.toContain("HIDDEN_REASONING_NEVER_PUBLIC");
});

test("UTF-8 and JSON-expanded output is bounded per event and per run with explicit truncation", async () => {
  const { events } = await builderFixture({ shell: async (output) => {
    // One external chunk exceeds both event and run limits. Control characters
    // require six JSON bytes each, while Chinese and emoji use multiple UTF-8 bytes.
    output(("中文🙂\u0000\\\"\n".repeat(300_000)));
  } });
  const logs = events.filter((event) => event.type === "tool.output");
  expect(logs.length).toBeGreaterThan(1);
  expect(logs.some((event) => event.truncated === true)).toBe(true);
  for (const event of logs) {
    const envelope = { schemaVersion: 1, eventId: "9223372036854775807", runId: randomUUID(), roleRunId: randomUUID(), attempt: 0, type: "tool.output", createdAt: event.at,
      payload: { message: event.message, toolCallId: event.toolCallId, toolName: event.toolName, truncated: event.truncated } };
    expect(Buffer.byteLength(JSON.stringify(envelope))).toBeLessThanOrEqual(16 * 1024);
    expect(event.message).not.toContain("\ufffd");
  }
  expect(logs.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event)), 0)).toBeLessThanOrEqual(2 * 1024 * 1024);
});

test("credentials remain redacted when their values and labels cross timed batches", async () => {
  const { events } = await builderFixture({ shell: async (output) => {
    output("开始检查 " + modelKey.slice(0, 13)); await delay(280);
    output(modelKey.slice(13) + " " + sandboxKey + " Bear"); await delay(280);
    output("er upstream-token-987\napi_"); await delay(280);
    output("key=another-token-654\n检查完成🙂\n");
  } });
  const visible = events.filter((event) => event.type === "tool.output").map((event) => event.message).join("");
  for (const secret of [modelKey, sandboxKey, "upstream-token-987", "another-token-654"]) expect(visible).not.toContain(secret);
  expect(visible).toContain("[REDACTED]");
  expect(visible).toContain("开始检查");
  expect(visible).toContain("检查完成🙂");
});

test("file tools expose useful result summaries without copying source or edit diffs into logs", async () => {
  const source = "export const privateFixtureSource = 'SOURCE_BODY_MUST_STAY_OUT_OF_LOGS';\n";
  const { events } = await builderFixture({ steps: [
    { name: "write", arguments: { path: "src/example.ts", content: source } },
    { name: "read", arguments: { path: "src/example.ts" } },
    { name: "edit", arguments: { path: "src/example.ts", oldText: "privateFixtureSource", newText: "publicFixtureSource" } },
  ] });
  const logs = events.filter((event) => event.type === "tool.output");
  expect(logs.map((event) => event.toolName)).toEqual(["write", "read", "edit"]);
  expect(logs.every((event) => event.message.includes("src/example.ts"))).toBe(true);
  expect(JSON.stringify(events)).not.toContain("SOURCE_BODY_MUST_STAY_OUT_OF_LOGS");
  expect(JSON.stringify(events)).not.toContain("privateFixtureSource");
});

test("a failed output persistence barrier stops the run and discards later output", async () => {
  const observed: ProbeEvent[] = [];
  await expect(builderFixture({
    shell: async (output) => { output("x".repeat(8192)); await delay(30); output("AFTER_OUTPUT_FAILURE"); },
    onEvent: async (event) => {
      observed.push(event);
      if (event.type === "tool.output") throw new Error("External event store unavailable");
    },
  })).rejects.toMatchObject({ code: "EVENT_APPEND_FAILED" });
  const count = observed.length;
  await delay(300);
  expect(observed).toHaveLength(count);
  expect(JSON.stringify(observed)).not.toContain("AFTER_OUTPUT_FAILURE");
});

test("cancelling a command discards its pending batch and leaves no delayed output", async () => {
  const controller = new AbortController();
  const observed: ProbeEvent[] = [];
  let lateOutput: ((value: string) => void) | undefined;
  await expect(builderFixture({ controller, onEvent: (event) => { observed.push(event); },
    shell: async (output) => { lateOutput = output; output("PENDING_BEFORE_CANCEL"); controller.abort(); await delay(5); },
  })).rejects.toMatchObject({ code: "CANCELLED" });
  const count = observed.length;
  lateOutput?.("OUTPUT_AFTER_CANCEL");
  await delay(300);
  expect(observed).toHaveLength(count);
  expect(observed.some((event) => event.type === "tool.output")).toBe(false);
});

test("a slow persistence sink has bounded queued batches and completes them before tool.end", async () => {
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  let active = 0, maximum = 0, outputEvents = 0;
  const { events } = await builderFixture({
    onEvent: async (event) => {
      maximum = Math.max(maximum, ++active);
      if (event.type === "tool.output" && ++outputEvents === 1) await barrier;
      active--;
    },
    shell: async (output) => {
      for (let i = 0; i < 100; i++) output("x".repeat(8192));
      await delay(30);
      expect(outputEvents).toBe(1);
      release();
    },
  });
  const logs = events.filter((event) => event.type === "tool.output");
  expect(maximum).toBe(1);
  expect(logs.length).toBeLessThanOrEqual(10); // One writing + eight queued + truncation notice.
  expect(logs[logs.length - 1].truncated).toBe(true);
  expect(events.indexOf(logs[logs.length - 1])).toBeLessThan(events.findIndex((event) => event.type === "tool.end"));
});

test("the total output budget holds across many successfully persisted batches", async () => {
  const { events } = await builderFixture({ shell: async (output) => {
    for (let i = 0; i < 400; i++) { output("x".repeat(8192)); await new Promise<void>((resolve) => setImmediate(resolve)); }
  } });
  const logs = events.filter((event) => event.type === "tool.output");
  const bytes = logs.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event)), 0);
  expect(bytes).toBeGreaterThan(1024 * 1024);
  expect(bytes).toBeLessThanOrEqual(2 * 1024 * 1024);
  expect(logs.filter((event) => event.truncated)).toHaveLength(1);
});

test("an unfinished credential label cannot accumulate an unbounded pending buffer", async () => {
  const { events } = await builderFixture({ shell: async (output) => {
    output("api_key" + " ".repeat(100_000) + "=unbounded-prefix-private-value\n");
  } });
  const logs = events.filter((event) => event.type === "tool.output");
  expect(logs.some((event) => event.truncated)).toBe(true);
  expect(JSON.stringify(events)).not.toContain("unbounded-prefix-private-value");
});
