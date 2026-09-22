import { normalizeContext, Type, type Context } from "@earendil-works/pi-ai";
import { expect, test } from "vitest";
import { createServiceModel } from "../../src/runtime/pi.js";
import { createRoleTokenTracker, createRunTokenBudget } from "../../src/runtime/token-budget.js";

const provider = "budget-wire-fixture", modelId = "wire-fixture";
function context(withMetadata: boolean) {
  const messages: Context["messages"] = [
    { role: "user", content: "Continue after the tool result.", timestamp: 1 },
    { role: "assistant", api: "openai-completions", provider, model: modelId, timestamp: 2, responseId: "fixture-response", rawStopReason: "tool_calls", stopReason: "toolUse",
      usage: { input: 80, output: 20, cacheRead: 100, cacheWrite: 0, totalTokens: 200, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      content: [{ type: "thinking", thinking: "FIXTURE_ONLY_THINKING_".repeat(100), thinkingSignature: "reasoning_content" },
        { type: "toolCall", id: "echo-1", name: "echo", arguments: { value: "fixture" } }] },
    { role: "toolResult", toolCallId: "echo-1", toolName: "echo", content: [{ type: "text", text: "fixture" }], isError: false, timestamp: 3,
      ...(withMetadata ? { details: { diff: "FIXTURE_DIFF_".repeat(2000), patch: "FIXTURE_PATCH_".repeat(2000) } } : {}) },
  ];
  return normalizeContext({ systemPrompt: "Complete the example with the supplied tool.",
    tools: [{ name: "echo", description: "Harmless echo", parameters: Type.Object({ value: Type.String() }) }], messages });
}

function response(usage?: Record<string, unknown>) {
  const chunk = { id: "fixture-response", object: "chat.completion.chunk", created: 1, model: modelId,
    choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }], ...(usage ? { usage } : {}) };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
}

test("identical actual Pi requests reserve the same budget despite local-only transcript metadata", async () => {
  const { runtime, model } = await createServiceModel({ provider, id: modelId, api: "openai-completions", baseUrl: "https://model-fixture.invalid/v1", apiKey: "fixture-not-a-real-key" });
  const wires: Record<string, unknown>[] = [], reservations: number[] = [];
  try {
    for (const withMetadata of [false, true]) {
      const budget = createRunTokenBudget(2500), tracker = createRoleTokenTracker(budget);
      const fetch: typeof globalThis.fetch = async (_url, init) => {
        wires.push(JSON.parse(String(init?.body)));
        reservations.push(budget.snapshot().accountedTokens);
        return response();
      };
      const input = context(withMetadata);
      const stream = tracker.stream(512, fetch, (budgetedFetch) => runtime.streamSimple(model, input, { maxTokens: 512, maxRetries: 0, fetch: budgetedFetch }));
      expect((await stream.result()).stopReason).toBe("stop");
      expect(tracker.usage()).toMatchObject({ modelCalls: 1, input: null, output: null, total: null });
      expect(budget.snapshot()).toMatchObject({ accountedTokens: reservations[reservations.length - 1], requests: 1, pendingRequests: 0, unreportedRequests: 1 });
    }
    expect(wires).toHaveLength(2);
    expect(wires[1]).toEqual(wires[0]);
    expect(reservations[1]).toBe(reservations[0]);
    expect(reservations[0]).toBeGreaterThan(512);
    expect(JSON.stringify(wires[0])).toContain("FIXTURE_ONLY_THINKING_");
    expect(JSON.stringify(wires[0])).not.toContain("FIXTURE_DIFF_");
    expect(wires[0].tools).toMatchObject([{ function: { name: "echo", parameters: { properties: { value: { type: "string" } } } } }]);
  } finally { await runtime.removeRuntimeApiKey(provider); }
});

const shortContext = () => normalizeContext({ messages: [{ role: "user", content: "Hi", timestamp: 1 }] });
const serviceModel = () => createServiceModel({ provider, id: modelId, api: "openai-completions", baseUrl: "https://model-fixture.invalid/v1", apiKey: "fixture-not-a-real-key" });

test("thinking actually sent on the wire cannot bypass the shared input budget", async () => {
  const { runtime, model } = await serviceModel();
  const budget = createRunTokenBudget(2500), tracker = createRoleTokenTracker(budget);
  let requests = 0;
  const input = context(false);
  for (const message of input.messages) if (message.role === "assistant") {
    for (const part of message.content) if (part.type === "thinking") part.thinking = "FIXTURE_THINKING_".repeat(1000);
  }
  try {
    const stream = tracker.stream(512, async () => { requests++; return response(); }, (fetch) => runtime.streamSimple(model, input, { maxTokens: 512, maxRetries: 0, fetch }));
    expect((await stream.result()).stopReason).toBe("error");
    expect(tracker.failure).toMatchObject({ code: "TOKEN_BUDGET_EXCEEDED" });
    expect(requests).toBe(0);
    expect(tracker.usage().modelCalls).toBe(0);
    expect(budget.snapshot()).toMatchObject({ requests: 0, accountedTokens: 0, pendingRequests: 0 });
  } finally { await runtime.removeRuntimeApiKey(provider); }
});

test("the actual wire output maximum is reserved even when it exceeds the caller estimate", async () => {
  const { runtime, model } = await serviceModel();
  const budget = createRunTokenBudget(1000), tracker = createRoleTokenTracker(budget);
  let requests = 0;
  try {
    const stream = tracker.stream(128, async () => { requests++; return response(); }, (fetch) => runtime.streamSimple(model, shortContext(), { maxTokens: 1024, maxRetries: 0, fetch }));
    expect((await stream.result()).stopReason).toBe("error");
    expect(tracker.failure).toMatchObject({ code: "TOKEN_BUDGET_EXCEEDED" });
    expect(requests).toBe(0);
    expect(tracker.usage().modelCalls).toBe(0);
  } finally { await runtime.removeRuntimeApiKey(provider); }
});

test.each([
  ["missing output maximum", JSON.stringify({ messages: [] })],
  ["invalid output maximum", JSON.stringify({ messages: [], max_completion_tokens: "512" })],
  ["invalid JSON", "not-json"],
  ["unsupported binary body", new Uint8Array([1, 2, 3])],
] as const)("a %s fails closed before provider I/O", async (_name, body) => {
  const { runtime, model } = await serviceModel();
  const budget = createRunTokenBudget(), tracker = createRoleTokenTracker(budget);
  let requests = 0;
  try {
    const stream = tracker.stream(512, async () => { requests++; return response(); }, (fetch) => runtime.streamSimple(model, shortContext(), {
      maxTokens: 512, maxRetries: 0, fetch: (url, init) => fetch(url, { ...init, body }),
    }));
    expect((await stream.result()).stopReason).toBe("error");
    expect(tracker.failure).toMatchObject({ code: "TOKEN_BUDGET_INVALID" });
    expect(requests).toBe(0);
    expect(tracker.usage().modelCalls).toBe(0);
    expect(budget.snapshot()).toMatchObject({ requests: 0, accountedTokens: 0, pendingRequests: 0 });
  } finally { await runtime.removeRuntimeApiKey(provider); }
});

test("caller cancellation before body inspection does not become a budget failure", async () => {
  const { runtime, model } = await serviceModel();
  const budget = createRunTokenBudget(), tracker = createRoleTokenTracker(budget), controller = new AbortController();
  let requests = 0;
  try {
    const stream = tracker.stream(512, async () => { requests++; return response(); }, (fetch) => runtime.streamSimple(model, shortContext(), {
      maxTokens: 512, maxRetries: 0, signal: controller.signal,
      fetch: (url, init) => { controller.abort(); return fetch(url, { ...init, body: new Uint8Array([1]) }); },
    }));
    expect((await stream.result()).stopReason).toBe("aborted");
    expect(tracker.failure).toBeUndefined();
    expect(requests).toBe(0);
    expect(tracker.usage().modelCalls).toBe(0);
    expect(budget.snapshot()).toMatchObject({ requests: 0, accountedTokens: 0, pendingRequests: 0 });
  } finally { await runtime.removeRuntimeApiKey(provider); }
});

test("an unexpected second fetch cannot reuse a stream reservation or release its unknown usage", async () => {
  const { runtime, model } = await serviceModel();
  const budget = createRunTokenBudget(), tracker = createRoleTokenTracker(budget);
  let requests = 0, reserved = 0, repeatedRejected = false;
  try {
    const stream = tracker.stream(512, async () => {
      requests++; reserved = budget.snapshot().accountedTokens;
      return response({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
    }, (fetch) => runtime.streamSimple(model, shortContext(), {
      maxTokens: 512, maxRetries: 0, fetch: async (url, init) => {
        const first = await fetch(url, init);
        try { await fetch(url, init); } catch { repeatedRejected = true; }
        return first;
      },
    }));
    await stream.result();
    expect(repeatedRejected).toBe(true);
    expect(tracker.failure).toMatchObject({ code: "MODEL_REQUEST_REPEATED" });
    expect(requests).toBe(1);
    expect(tracker.usage()).toMatchObject({ modelCalls: 1, output: null, total: null });
    expect(budget.snapshot()).toMatchObject({ requests: 1, accountedTokens: reserved, pendingRequests: 0, unreportedRequests: 1 });
  } finally { await runtime.removeRuntimeApiKey(provider); }
});

test("concurrent Pi streams have separate reservations and settle each usage exactly once", async () => {
  const { runtime, model } = await serviceModel();
  const budget = createRunTokenBudget(2500), tracker = createRoleTokenTracker(budget);
  const releases: (() => void)[] = [];
  const fetch: typeof globalThis.fetch = async () => {
    await new Promise<void>((resolve) => { releases.push(resolve); });
    return response({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  };
  try {
    const start = () => tracker.stream(512, fetch, (budgetedFetch) => runtime.streamSimple(model, shortContext(), { maxTokens: 512, maxRetries: 0, fetch: budgetedFetch }));
    const first = start(), second = start();
    await expect.poll(() => releases.length).toBe(2);
    expect(budget.snapshot()).toMatchObject({ requests: 2, pendingRequests: 2 });
    releases[1](); await second.result();
    expect(budget.snapshot().pendingRequests).toBe(1);
    releases[0](); await first.result();
    expect(tracker.failure).toBeUndefined();
    expect(tracker.usage()).toMatchObject({ modelCalls: 2, input: 20, output: 10, total: 30 });
    expect(budget.snapshot()).toMatchObject({ requests: 2, pendingRequests: 0, accountedTokens: 30 });
  } finally { for (const release of releases) release(); await runtime.removeRuntimeApiKey(provider); }
});

test("the supported Anthropic SDK sends a JSON string with max_tokens through the wire budget", async () => {
  const anthropicProvider = "budget-anthropic-fixture";
  const { runtime, model } = await createServiceModel({ provider: anthropicProvider, id: modelId, api: "anthropic-messages", baseUrl: "https://anthropic-fixture.invalid/v1", apiKey: "fixture-not-a-real-key" });
  const budget = createRunTokenBudget(2500), tracker = createRoleTokenTracker(budget);
  let requests = 0;
  try {
    const stream = tracker.stream(512, async (_url, init) => {
      requests++;
      expect(typeof init?.body).toBe("string");
      expect(JSON.parse(String(init?.body))).toMatchObject({ max_tokens: 512, messages: [{ role: "user" }] });
      expect(budget.snapshot().accountedTokens).toBeGreaterThan(512);
      const events = [
        { type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant", model: modelId, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
        { type: "message_stop" },
      ];
      return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    }, (fetch) => runtime.streamSimple(model, shortContext(), { maxTokens: 512, maxRetries: 0, fetch }));
    expect((await stream.result()).stopReason).toBe("stop");
    expect(tracker.failure).toBeUndefined();
    expect(requests).toBe(1);
    expect(tracker.usage()).toMatchObject({ modelCalls: 1, input: 10, output: 5, total: 15 });
    expect(budget.snapshot()).toMatchObject({ requests: 1, pendingRequests: 0, accountedTokens: 15 });
  } finally { await runtime.removeRuntimeApiKey(anthropicProvider); }
});
