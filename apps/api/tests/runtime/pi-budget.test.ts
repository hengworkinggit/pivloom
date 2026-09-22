import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { runBuilder } from "../../src/runtime/pi.js";
import { runCoordinator } from "../../src/runtime/coordinator.js";
import { OpenSandboxWorkspace, type SandboxConnection } from "../../src/runtime/workspace.js";
import { createRunTokenBudget, type RunTokenBudget } from "../../src/runtime/token-budget.js";
import type { ProbeEventSink } from "../../src/runtime/types.js";

// Real Pi and workspace adapter; only provider HTTP and remote connector I/O
// are fixtures. No model, sandbox or generated code runs on the host.
async function builder(options: {
  budget: RunTokenBudget;
  fetch: typeof globalThis.fetch;
  maxToolCalls?: number;
  controller?: AbortController;
  onEvent?: ProbeEventSink;
}) {
  let live = true;
  const connection: SandboxConnection = {
    sandboxId: randomUUID(), kill: async () => { live = false; }, isRunning: async () => live,
    renew: async () => {}, close: async () => {}, read: async () => Buffer.from("fixture source"), write: async () => {},
    endpoint: async () => ({ url: "https://unused.invalid", headers: {} }),
    run: async () => ({ id: randomUUID(), interrupt: async () => {}, wait: async () => ({ exitCode: 0, stdoutTail: "", stderrTail: "" }) }),
  };
  const workspace = new OpenSandboxWorkspace({ baseUrl: "http://127.0.0.1:18080", apiKey: "sandbox-fixture", image: "fixture" }, { create: async () => connection });
  const signal = (options.controller ?? new AbortController()).signal;
  const handle = await workspace.create({ runId: randomUUID(), signal });
  try {
    return await runBuilder({ workspace, handle, prompt: "实现一个简洁的读书清单", signal, tokenBudget: options.budget, maxToolCalls: options.maxToolCalls, onEvent: options.onEvent,
      modelConfig: { provider: "budget-fixture", id: "budget-fixture", baseUrl: "https://model.invalid/v1", api: "openai-completions", apiKey: "model-budget-fixture", fetch: options.fetch } });
  } finally { await workspace.destroy(handle); expect(live).toBe(false); }
}

function response(delta: Record<string, unknown>, usage?: Record<string, unknown>) {
  const chunk = { id: "budget-response", object: "chat.completion.chunk", created: 1, model: "budget-fixture", choices: [{ index: 0, delta, finish_reason: null }] };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }], ...(usage ? { usage } : {}) })}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
}

test("Builder refuses an exhausted shared token budget before provider I/O", async () => {
  let requests = 0;
  await expect(builder({ budget: createRunTokenBudget(1), fetch: async () => { requests++; throw new Error("No provider call is permitted"); } }))
    .rejects.toMatchObject({ code: "TOKEN_BUDGET_EXCEEDED", usage: { modelCalls: 0, toolCalls: 0, input: null, output: null, total: null, cachedTokens: null, source: "unreported" } });
  expect(requests).toBe(0);
});

test("role usage records actual provider attempts, cached tokens, elapsed time and source", async () => {
  const budget = createRunTokenBudget();
  const result = await builder({ budget, fetch: async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    return response({ role: "assistant", content: "已完成" }, { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50, prompt_tokens_details: { cached_tokens: 20 } });
  } });
  expect(result.usage).toMatchObject({ input: 20, output: 10, total: 50, cachedTokens: 20, modelCalls: 1, toolCalls: 0, source: "reported" });
  expect(result.usage.elapsedMs).toBeGreaterThanOrEqual(20);
  expect(budget.snapshot().accountedTokens).toBe(50);
});

test("Builder does not turn an exhausted run tool budget into one more permitted call", async () => {
  let requests = 0;
  await expect(builder({ budget: createRunTokenBudget(), maxToolCalls: 0, fetch: async () => { requests++; throw new Error("No provider call is permitted"); } }))
    .rejects.toMatchObject({ code: "TOOL_BUDGET_EXCEEDED" });
  expect(requests).toBe(0);
});

test("Coordinator and Builder charge the same run ledger, including cached prompt tokens", async () => {
  const budget = createRunTokenBudget();
  const plan = { schemaVersion: 1, goal: "记录书名", changeSummary: "增加书单", assumptions: [], outOfScope: [],
    behaviors: [{ id: "B01", title: "添加书名", precondition: "页面已打开", action: "输入书名并添加", expected: "出现书名", required: true }] };
  const coordinator = await runCoordinator({
    runId: randomUUID(), roleRunId: randomUUID(), sessionId: randomUUID(), attempt: 0, baseRevisionId: null,
    tokenBudget: budget, signal: new AbortController().signal,
    context: { schemaVersion: 1, project: { id: randomUUID(), title: "书单" }, requestText: "创建书单", originalRequest: "创建书单", clarificationTurns: [], baseRevisionId: null, previousPlan: null },
    modelConfig: { provider: "budget-fixture", id: "budget-fixture", baseUrl: "https://model.invalid/v1", api: "openai-completions", apiKey: "model-budget-fixture",
      fetch: async () => response({ role: "assistant", tool_calls: [{ index: 0, id: "plan", type: "function", function: { name: "submit_plan", arguments: JSON.stringify({ plan }) } }] },
        { prompt_tokens: 57000, completion_tokens: 1000, total_tokens: 58000, prompt_tokens_details: { cached_tokens: 52000 } }),
    },
    assertActive: async () => {}, onDecision: async () => {},
  });
  expect(coordinator.usage).toMatchObject({ input: 5000, output: 1000, total: 58000, cachedTokens: 52000, modelCalls: 1, toolCalls: 1, source: "reported" });
  let builderRequests = 0;
  await expect(builder({ budget, fetch: async () => { builderRequests++; return response({ content: "已完成" }); } }))
    .rejects.toMatchObject({ code: "TOKEN_BUDGET_EXCEEDED" });
  expect(builderRequests).toBe(0);
  expect(budget.snapshot()).toMatchObject({ accountedTokens: 58000, requests: 1, pendingRequests: 0 });
});

test("a Builder tool turn settles usage before the next model request is authorized", async () => {
  const budget = createRunTokenBudget();
  let requests = 0;
  await expect(builder({ budget, fetch: async () => {
    requests++;
    return response({ role: "assistant", tool_calls: [{ index: 0, id: "command", type: "function", function: { name: "bash", arguments: '{"command":"true"}' } }] },
      { prompt_tokens: 57000, completion_tokens: 1000, total_tokens: 58000 });
  } })).rejects.toMatchObject({ code: "TOKEN_BUDGET_EXCEEDED", usage: { input: 57000, output: 1000, total: 58000, cachedTokens: null, modelCalls: 1, toolCalls: 1, source: "partial" } });
  expect(requests).toBe(1);
  expect(budget.snapshot()).toMatchObject({ accountedTokens: 58000, pendingRequests: 0 });
});

test.each([undefined, { prompt_tokens: 10 }])("Builder reports incomplete usage as unknown and retains its reservation: %j", async (usage) => {
  const budget = createRunTokenBudget();
  let reserved = 0, requestedOutput = 0;
  const result = await builder({ budget, fetch: async (_url, init) => {
    reserved = budget.snapshot().accountedTokens;
    const body = JSON.parse(String(init?.body));
    requestedOutput = body.max_tokens ?? body.max_completion_tokens;
    return response({ role: "assistant", content: "已完成" }, usage);
  } });
  expect(result.usage).toMatchObject({ input: usage ? 10 : null, output: null, total: null, cachedTokens: null, modelCalls: 1, toolCalls: 0, source: usage ? "partial" : "unreported" });
  expect(requestedOutput).toBeGreaterThan(0);
  expect(reserved).toBeGreaterThan(requestedOutput);
  expect(budget.snapshot()).toMatchObject({ accountedTokens: reserved, pendingRequests: 0, unreportedRequests: 1 });
});

test("aborting after actual Pi stream content does not release a reservation against provisional usage", async () => {
  const budget = createRunTokenBudget();
  const controller = new AbortController();
  let transportAborted = false, reserved = 0, requestedOutput = 0;
  await expect(builder({ budget, controller,
    onEvent: (event) => { if (event.type === "model.stream.started") controller.abort(); },
    fetch: async (_url, init) => {
      reserved = budget.snapshot().accountedTokens;
      const body = JSON.parse(String(init?.body));
      requestedOutput = body.max_tokens ?? body.max_completion_tokens;
      const chunk = { id: "partial", object: "chat.completion.chunk", created: 1, model: "budget-fixture",
        choices: [{ index: 0, delta: { role: "assistant", content: "正在生成" }, finish_reason: null }],
        usage: { prompt_tokens: 1000, completion_tokens: 1, total_tokens: 1001 } };
      return new Response(new ReadableStream({ start(stream) {
        stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
        init?.signal?.addEventListener("abort", () => { transportAborted = true; stream.error(new DOMException("Fixture transport aborted", "AbortError")); }, { once: true });
      } }), { headers: { "Content-Type": "text/event-stream" } });
    },
  })).rejects.toMatchObject({ code: "CANCELLED", usage: { input: 1000, output: null, total: null, cachedTokens: null, modelCalls: 1, toolCalls: 0, source: "partial" } });
  expect(transportAborted).toBe(true);
  expect(requestedOutput).toBeGreaterThan(0);
  expect(reserved).toBeGreaterThan(requestedOutput);
  expect(budget.snapshot()).toMatchObject({ accountedTokens: reserved, pendingRequests: 0, unreportedRequests: 1 });
});

test("a failed HTTP attempt is counted without inventing provider token usage", async () => {
  await expect(builder({ budget: createRunTokenBudget(), fetch: async () => { throw new Error("External HTTP fixture unavailable"); } }))
    .rejects.toMatchObject({ code: "MODEL_FAILED", usage: { modelCalls: 1, toolCalls: 0, input: null, output: null, total: null, cachedTokens: null, source: "unreported" } });
});
