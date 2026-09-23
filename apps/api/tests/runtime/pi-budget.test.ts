import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { runBuilder } from "../../src/runtime/pi.js";
import { runCoordinator } from "../../src/runtime/coordinator.js";
import { OpenSandboxWorkspace, type SandboxConnection } from "../../src/runtime/workspace.js";
import { createRunTokenBudget, type RunTokenBudget } from "../../src/runtime/token-budget.js";
import { PROVIDER_RETRY_POLICY } from "../../src/runtime/budgets.js";
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

test("Coordinator and Builder charge the same lower run budget, including cached prompt tokens", async () => {
  const budget = createRunTokenBudget(60_000);
  const plan = { schemaVersion: 2, goal: "记录书名", changeSummary: "增加书单", assumptions: [], outOfScope: [],
    behaviors: ["B01", "B02", "B03", "B04", "B05"].map((id) => ({ id, title: `书单检查 ${id}`,
      precondition: "页面已打开", action: `执行 ${id}`, expected: `出现 ${id} 结果`, required: true })),
    groups: ["G1", "G2", "G3", "G4", "G5"].map((id, index) => ({ id, title: `验收组 ${index + 1}`, behaviorIds: [`B0${index + 1}`] })),
    replacements: [] };
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
  const budget = createRunTokenBudget(60_000);
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

test("the settings catalog is Pi's own provider list, limited to providers that accept an API key", async () => {
  const { listModelCatalog } = await import("../../src/runtime/pi.js");
  const { providers } = await listModelCatalog();
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  // A provider a user can configure with a pasted key, with a default endpoint
  // and its models, exactly like Pi's own selection list.
  const moonshot = byId.get("moonshotai-cn");
  expect(moonshot?.baseUrl).toMatch(/^https:\/\//);
  expect(moonshot?.models.some((model) => model.id.startsWith("kimi-"))).toBe(true);
  // Only protocols this runtime can drive are offered; the catalog's
  // google/openai-responses/bedrock entries must not leak into the picker.
  expect(providers.every((provider) => provider.models.every((model) => ["openai-completions", "anthropic-messages"].includes(model.api)))).toBe(true);
  expect(providers.some((provider) => provider.id === "google")).toBe(false);
  // OAuth-only providers cannot be configured with a key, so they are not offered.
  expect(byId.has("openai-codex")).toBe(false);
  expect(providers.every((provider) => provider.models.length > 0)).toBe(true);
}, 60_000);

test("a BYOK model that exists in Pi's catalog inherits Pi's own protocol adaptation", async () => {
  const { createServiceModel } = await import("../../src/runtime/pi.js");
  const config = { provider: "pivloom-byok", api: "openai-completions" as const,
    baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3", apiKey: "fixture-api-key" };
  // glm-5.3-flash ships in Pi's catalog under a coding-plan provider whose entry
  // carries thinking format, developer-role and store flags. A BYOK profile must
  // inherit exactly that instead of a bare entry with no compat at all.
  const known = await createServiceModel({ ...config, id: "glm-5.3-flash" });
  // The catalog entry for this id lives under another provider's endpoint, so it
  // must NOT leak its adaptation onto this endpoint.
  expect(Object.keys(known.model.compat ?? {})).toHaveLength(0);
  // An entry whose endpoint matches the configured one is inherited as-is.
  const sameEndpoint = await createServiceModel({ ...config, id: "kimi-k2.6",
    baseUrl: "https://api.moonshot.cn/v1" });
  expect(sameEndpoint.model.compat).toMatchObject({ thinkingFormat: "deepseek", supportsDeveloperRole: false });
  expect(sameEndpoint.model.reasoning).toBe(true);
  // A model Pi does not know still works, just without inherited adaptation.
  const unknown = await createServiceModel({ ...config, id: "pivloom-unknown-model" });
  expect(Object.keys(unknown.model.compat ?? {})).toHaveLength(0);
});

test("a transient transport failure is retried within the policy and every attempt is counted without inventing usage", async () => {
  const attempts = { count: 0 };
  await expect(builder({ budget: createRunTokenBudget(), fetch: async () => { attempts.count++; throw new Error("External HTTP fixture unavailable"); } }))
    .rejects.toMatchObject({ code: "MODEL_FAILED", usage: { modelCalls: PROVIDER_RETRY_POLICY.maxRetries + 1, toolCalls: 0, input: null, output: null, total: null, cachedTokens: null, source: "unreported" } });
  expect(attempts.count).toBe(PROVIDER_RETRY_POLICY.maxRetries + 1);
}, 90_000);

test("a successful tool turn resets Pi's consecutive provider retry attempt before the next turn", async () => {
  let requests = 0;
  const retryMessages: string[] = [];
  const result = await builder({ budget: createRunTokenBudget(), onEvent: (event) => {
    if (event.type === "model.stream.started" && event.message.includes("次瞬态失败")) retryMessages.push(event.message);
  }, fetch: async () => {
    requests++;
    if (requests === 1 || requests === 3) throw new Error("Transient transport unavailable");
    if (requests === 2) return response({ role: "assistant", tool_calls: [{ index: 0, id: "command", type: "function", function: { name: "bash", arguments: '{"command":"true"}' } }] });
    return response({ role: "assistant", content: "两轮都已完成" });
  } });
  expect(result.text).toContain("两轮都已完成");
  expect(requests).toBe(4);
  expect(result.usage.modelCalls).toBe(4);
  expect(retryMessages).toHaveLength(2);
  expect(retryMessages.every((message) => message.includes(`第 1/${PROVIDER_RETRY_POLICY.maxRetries} 次瞬态失败`))).toBe(true);
}, 30_000);

test("stopping during Pi's retry backoff prevents a second Provider request", async () => {
  const controller = new AbortController();
  let requests = 0, sawRetry = false;
  await expect(builder({ budget: createRunTokenBudget(), controller,
    onEvent: (event) => {
      if (event.type === "model.stream.started" && event.message.includes("次瞬态失败")) {
        sawRetry = true;
        controller.abort("CANCELLED");
      }
    },
    fetch: async () => { requests++; throw new Error("Transient Provider transport failure"); },
  })).rejects.toMatchObject({ code: "CANCELLED" });
  expect(sawRetry).toBe(true);
  expect(requests).toBe(1);
}, 30_000);

test("a deterministic provider rejection is not retried", async () => {
  let attempts = 0;
  await expect(builder({ budget: createRunTokenBudget(), fetch: async () => {
    attempts++;
    return new Response(JSON.stringify({ error: { message: "quota exceeded for this account", type: "invalid_request_error" } }),
      { status: 400, headers: { "Content-Type": "application/json" } });
  } })).rejects.toMatchObject({ code: "MODEL_FAILED", usage: { modelCalls: 1, toolCalls: 0 } });
  expect(attempts).toBe(1);
});
