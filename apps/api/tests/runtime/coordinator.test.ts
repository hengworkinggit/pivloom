import { randomUUID } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { runCoordinator } from "../../src/runtime/coordinator.js";
import { createRunTokenBudget } from "../../src/runtime/token-budget.js";
import type { ProbeEvent } from "../../src/runtime/types.js";

// External provider SSE and persistence/active-role callbacks are fixtures.
// The Pi session, allowlist, schema validation and lifecycle are real code.
const key = "coordinator-private-fixture-key";
const plan = {
  schemaVersion: 1 as const,
  goal: "记录读书进度",
  changeSummary: "提供新增书籍和标记已读的前端页面",
  assumptions: ["演示数据保存在当前浏览器"],
  outOfScope: ["不提供跨用户后端同步"],
  behaviors: [{ id: "B01", title: "添加一本书", precondition: "书单页面已打开", action: "输入书名并点击添加", expected: "列表中出现输入的书名", required: true }],
};
const context = () => ({
  schemaVersion: 1 as const, project: { id: randomUUID(), title: "读书清单" },
  requestText: "做一个读书清单", originalRequest: "做一个读书清单",
  clarificationTurns: [], baseRevisionId: null, previousPlan: null,
});
type Call = { name: string; args: unknown; id?: string };
interface ProviderRequest {
  messages: Array<{ role: string; content: unknown }>;
  tools: Array<{ function: { name: string; parameters: Record<string, unknown> } }>;
}
function provider(turns: Array<Call[] | string>, apiKey = key, usage?: Array<Record<string, unknown> | null>) {
  const requests: ProviderRequest[] = [];
  const authorizations: Array<string | null> = [];
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    authorizations.push(new Headers(init?.headers).get("authorization"));
    const turn = turns[requests.length - 1] ?? "已完成。";
    const delta = typeof turn === "string" ? { role: "assistant", content: turn } : {
      role: "assistant", reasoning_content: "PRIVATE_COORDINATOR_REASONING",
      tool_calls: turn.map((call, index) => ({ index, id: call.id ?? `call-${requests.length}-${index}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } })),
    };
    const chunk = { id: `response-${requests.length}`, object: "chat.completion.chunk", created: 1, model: "coordinator-fixture", choices: [{ index: 0, delta, finish_reason: null }] };
    const reportedUsage = usage ? usage[requests.length - 1] : { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: typeof turn === "string" ? "stop" : "tool_calls" }], ...(reportedUsage ? { usage: reportedUsage } : {}) })}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
  };
  return { requests, authorizations, modelConfig: { provider: "coordinator-fixture", id: "coordinator-fixture", api: "openai-completions" as const, baseUrl: "https://model-fixture.invalid/v1", apiKey, fetch } };
}

test("the actual provider request declares concrete required question and plan fields", async () => {
  const model = provider([[{ name: "request_clarification", args: { question: "奖金计算公式是什么？" } }]]);
  await runCoordinator({
    runId: randomUUID(), roleRunId: randomUUID(), sessionId: randomUUID(), attempt: 0, baseRevisionId: null,
    modelConfig: model.modelConfig, signal: new AbortController().signal, context: context(),
    assertActive: async () => {}, onDecision: async () => {},
  });
  const declared = Object.fromEntries(model.requests[0].tools.map((tool) => [tool.function.name, tool.function.parameters]));
  expect(declared.request_clarification).toMatchObject({ type: "object", required: ["question"], additionalProperties: false,
    properties: { question: { type: "string", minLength: 1, maxLength: 300 } } });
  expect(declared.submit_plan).toMatchObject({ type: "object", required: ["plan"], additionalProperties: false,
    properties: { plan: { type: "object", required: ["schemaVersion", "goal", "changeSummary", "assumptions", "outOfScope", "behaviors"],
      properties: { behaviors: { type: "array", minItems: 1, maxItems: 5, items: { type: "object", required: ["id", "title", "precondition", "action", "expected", "required"] } } } } } });
});

test("the real four-part clarification is rejected and receives one correction to a single essential question", async () => {
  const fourQuestions = "请提供绩效奖金的关键计算规则，以便准确实现：\n1) 计算公式是什么？例如：奖金 = 月基本工资 × 绩效系数 × 考核得分比例，还是其他结构（阶梯提成、目标奖金 × 完成率等）？\n2) 页面需要哪些输入项及其取值范围（如基本工资、绩效系数、考核评分/完成率）？\n3) 结果如何处理：四舍五入到元还是保留两位小数？\n4) 是否需要历史计算记录或导出功能，还是单次计算即可？";
  const question = "绩效奖金应按什么公式计算？";
  const model = provider([[{ name: "request_clarification", args: { question: fourQuestions } }], [{ name: "request_clarification", args: { question } }]]);
  const decisions: unknown[] = [];
  const result = await runCoordinator({
    runId: randomUUID(), roleRunId: randomUUID(), sessionId: randomUUID(), attempt: 0, baseRevisionId: null,
    modelConfig: model.modelConfig, signal: new AbortController().signal,
    context: { ...context(), requestText: "奖金计算公式尚未提供，请先问清规则，不要自行假设公式。" },
    assertActive: async () => {}, onDecision: async (decision) => { decisions.push(decision); },
  });
  expect(decisions).toEqual([{ kind: "clarification", question }]);
  expect(result.toolCalls.map((call) => call.success)).toEqual([false, true]);
  expect(model.requests).toHaveLength(2);
});

test("two empty clarification calls exhaust the server correction budget with safe schema diagnostics", async () => {
  const model = provider([
    [{ name: "request_clarification", args: {} }],
    [{ name: "request_clarification", args: {} }],
    [{ name: "request_clarification", args: { question: "不应到达第三次" } }],
  ]);
  const events: ProbeEvent[] = [];
  let commits = 0;
  await expect(runCoordinator({
    runId: randomUUID(), roleRunId: randomUUID(), sessionId: randomUUID(), attempt: 0, baseRevisionId: null,
    modelConfig: model.modelConfig, signal: new AbortController().signal, context: context(),
    assertActive: async () => {}, onEvent: (event) => { events.push(event); }, onDecision: async () => { commits++; },
  })).rejects.toMatchObject({ code: "AGENT_OUTPUT_INVALID" });
  expect(commits).toBe(0);
  expect(model.requests).toHaveLength(2);
  expect(events.filter((event) => event.type === "tool.start")).toHaveLength(2);
  const diagnostics = events.filter((event) => event.type === "tool.output");
  expect(diagnostics).toHaveLength(2);
  expect(diagnostics.every((event) => event.message.includes("question:invalid_type"))).toBe(true);
});

test("invalid argument diagnostics never echo unknown field names, values or reasoning", async () => {
  const secretField = "PRIVATE_ARGUMENT_FIELD", secretValue = "PRIVATE_ARGUMENT_VALUE";
  const model = provider([
    [{ name: "request_clarification", args: { [secretField]: secretValue, [key]: key } }],
    [{ name: "request_clarification", args: { question: "奖金计算公式是什么？" } }],
  ]);
  const events: ProbeEvent[] = [];
  const result = await runCoordinator({
    runId: randomUUID(), roleRunId: randomUUID(), sessionId: randomUUID(), attempt: 0, baseRevisionId: null,
    modelConfig: model.modelConfig, signal: new AbortController().signal, context: context(),
    assertActive: async () => {}, onEvent: (event) => { events.push(event); }, onDecision: async () => {},
  });
  expect(result.decision.kind).toBe("clarification");
  expect(events.some((event) => event.type === "tool.output" && event.message.includes("question:invalid_type"))).toBe(true);
  for (const secret of [secretField, secretValue, key, "PRIVATE_COORDINATOR_REASONING"]) expect(JSON.stringify(events)).not.toContain(secret);
});

test("the shared token budget rejects a Coordinator request before provider I/O or handoff", async () => {
  const model = provider([[{ name: "submit_plan", args: { plan } }]]);
  let commits = 0;
  await expect(runCoordinator({
    runId: randomUUID(), roleRunId: randomUUID(), sessionId: randomUUID(), attempt: 0, baseRevisionId: null,
    modelConfig: model.modelConfig, signal: new AbortController().signal, context: context(),
    tokenBudget: createRunTokenBudget(1),
    assertActive: async () => {}, onDecision: async () => { commits++; },
  })).rejects.toMatchObject({ code: "TOKEN_BUDGET_EXCEEDED" });
  expect(model.requests).toHaveLength(0);
  expect(commits).toBe(0);
});

test.each(["structured", "plain-text"] as const)("cache-inclusive usage blocks a %s correction before its provider request", async (kind) => {
  const model = provider([
    kind === "structured" ? [{ name: "submit_plan", args: { plan: { ...plan, behaviors: [] } } }] : "已规划，请直接开始。",
    [{ name: "submit_plan", args: { plan } }],
  ], key, [{ prompt_tokens: 57000, completion_tokens: 1000, total_tokens: 58000, prompt_tokens_details: { cached_tokens: 52000 } }]);
  const budget = createRunTokenBudget(60_000);
  let commits = 0;
  await expect(runCoordinator({
    runId: randomUUID(), roleRunId: randomUUID(), sessionId: randomUUID(), attempt: 0, baseRevisionId: null,
    modelConfig: model.modelConfig, signal: new AbortController().signal, context: context(), tokenBudget: budget,
    assertActive: async () => {}, onDecision: async () => { commits++; },
  })).rejects.toMatchObject({ code: "TOKEN_BUDGET_EXCEEDED", usage: { input: 5000, output: 1000, total: 58000 } });
  expect(model.requests).toHaveLength(1);
  expect(commits).toBe(0);
  expect(budget.snapshot()).toMatchObject({ accountedTokens: 58000, pendingRequests: 0 });
});

test.each([null, { completion_tokens: 5 }, { prompt_tokens: 10 }])("incomplete provider usage retains the request reservation before a correction: %j", async (usage) => {
  const model = provider(["普通文字不是结构化交接", [{ name: "submit_plan", args: { plan } }]], key, [usage]);
  const budget = createRunTokenBudget(10000);
  await expect(runCoordinator({
    runId: randomUUID(), roleRunId: randomUUID(), sessionId: randomUUID(), attempt: 0, baseRevisionId: null,
    modelConfig: model.modelConfig, signal: new AbortController().signal, context: context(), tokenBudget: budget,
    assertActive: async () => {}, onDecision: async () => { throw new Error("No handoff should be reached"); },
  })).rejects.toMatchObject({ code: "TOKEN_BUDGET_EXCEEDED" });
  expect(model.requests).toHaveLength(1);
  expect(budget.snapshot().accountedTokens).toBeGreaterThan(4096);
  expect(budget.snapshot()).toMatchObject({ pendingRequests: 0, unreportedRequests: 1 });
});

test("Coordinator advertises only its three tools and cannot execute host shell or file writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pivloom-coordinator-test-"));
  const target = join(directory, "forbidden.txt");
  const model = provider([
    [{ name: "bash", args: { command: `printf forbidden > '${target}'` } }],
    [{ name: "write", args: { path: target, content: "forbidden" } }],
    [{ name: "project_summary", args: {} }],
    [{ name: "submit_plan", args: { plan } }],
  ]);
  const events: ProbeEvent[] = [], decisions: unknown[] = [];
  const sessionId = randomUUID();
  try {
    const result = await runCoordinator({
      runId: randomUUID(), roleRunId: randomUUID(), sessionId, attempt: 0, baseRevisionId: null,
      modelConfig: model.modelConfig, signal: new AbortController().signal, context: context(),
      assertActive: async () => {}, onEvent: (event) => { events.push(event); },
      onDecision: async (decision, metadata) => { decisions.push({ decision, metadata }); },
    });
    expect(result.decision).toEqual({ kind: "plan", plan });
    expect(result.sessionId).toBe(sessionId);
    expect(decisions).toHaveLength(1);
    for (const request of model.requests) expect(request.tools.map((tool) => tool.function.name).sort()).toEqual(["project_summary", "request_clarification", "submit_plan"]);
    expect(JSON.stringify(model.requests)).toContain("Tool bash not found");
    expect(JSON.stringify(model.requests)).toContain("Tool write not found");
    await expect(access(target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(events.every((event) => event.sessionId === sessionId)).toBe(true);
    expect(JSON.stringify(events)).not.toContain(key);
    expect(JSON.stringify(events)).not.toContain("PRIVATE_COORDINATOR_REASONING");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a single clarification is committed after tool events and does not recheck an ended role", async () => {
  const question = "这里的额度指使用次数还是可支出的金额？";
  const model = provider([[{ name: "request_clarification", args: { question } }]]);
  const order: string[] = [];
  let active = true;
  const result = await runCoordinator({
    runId: randomUUID(), roleRunId: randomUUID(), sessionId: randomUUID(), attempt: 0, baseRevisionId: null,
    modelConfig: model.modelConfig, signal: new AbortController().signal, context: context(),
    assertActive: async () => { if (!active) throw new Error("Role ended after its terminal transaction"); },
    onEvent: async (event) => { expect(active).toBe(true); await new Promise<void>((resolve) => setTimeout(resolve, 1)); order.push(event.type); },
    onDecision: async (decision, metadata) => {
      expect(decision).toEqual({ kind: "clarification", question });
      expect(metadata.usage).toMatchObject({ input: 10, output: 5, total: 15, cachedTokens: null, modelCalls: 1, toolCalls: 1, source: "partial" });
      expect(metadata.toolCalls).toHaveLength(1);
      expect(order[order.length - 1]).toBe("tool.end");
      active = false; order.push("transaction");
    },
  });
  expect(result.decision).toEqual({ kind: "clarification", question });
  expect(order[order.length - 1]).toBe("transaction");
  expect(model.requests).toHaveLength(1);
});

test("a plan whose schemaVersion is wrong or missing is accepted without spending the correction turn", async () => {
  const { schemaVersion: _omitted, ...withoutVersion } = plan;
  const model = provider([
    [{ name: "submit_plan", args: { plan: { ...withoutVersion, schemaVersion: "1" } } }],
  ]);
  const accepted: unknown[] = [];
  const result = await runCoordinator({
    runId: randomUUID(), roleRunId: randomUUID(), sessionId: randomUUID(), attempt: 0, baseRevisionId: null,
    modelConfig: model.modelConfig, signal: new AbortController().signal, context: context(),
    assertActive: async () => {}, onDecision: async (decision) => { accepted.push(decision); },
  });
  // The service owns the plan schema version, so the persisted plan is well
  // formed and the real plan fields are untouched.
  expect(accepted).toEqual([{ kind: "plan", plan }]);
  expect(result.toolCalls.map((call) => call.success)).toEqual([true]);
  expect(model.requests).toHaveLength(1);
});

test("one invalid structured submission can be corrected before the only handoff transaction", async () => {
  const model = provider([
    [{ name: "submit_plan", args: { plan: { ...plan, behaviors: [] } } }],
    [{ name: "submit_plan", args: { plan } }],
  ]);
  const accepted: unknown[] = [];
  const result = await runCoordinator({
    runId: randomUUID(), roleRunId: randomUUID(), sessionId: randomUUID(), attempt: 0, baseRevisionId: null,
    modelConfig: model.modelConfig, signal: new AbortController().signal, context: context(),
    assertActive: async () => {}, onDecision: async (decision) => { accepted.push(decision); },
  });
  expect(accepted).toEqual([{ kind: "plan", plan }]);
  expect(result.toolCalls.map((call) => call.success)).toEqual([false, true]);
  expect(model.requests).toHaveLength(2);
});

test("two invalid submissions fail with AGENT_OUTPUT_INVALID and never commit a handoff", async () => {
  const model = provider([
    [{ name: "submit_plan", args: { plan: { ...plan, behaviors: [] } } }],
    [{ name: "request_clarification", args: { question: " " } }],
    [{ name: "submit_plan", args: { plan } }],
  ]);
  let commits = 0;
  await expect(runCoordinator({
    runId: randomUUID(), roleRunId: randomUUID(), sessionId: randomUUID(), attempt: 0, baseRevisionId: null,
    modelConfig: model.modelConfig, signal: new AbortController().signal, context: context(),
    assertActive: async () => {}, onDecision: async () => { commits++; },
  })).rejects.toMatchObject({ code: "AGENT_OUTPUT_INVALID" });
  expect(commits).toBe(0);
  expect(model.requests).toHaveLength(2);
});

test("multiple decision calls in one model turn cannot commit duplicate or conflicting handoffs", async () => {
  const model = provider([[
    { name: "submit_plan", args: { plan } },
    { name: "request_clarification", args: { question: "不应提交的第二个问题？" } },
  ]]);
  const accepted: unknown[] = [];
  const result = await runCoordinator({
    runId: randomUUID(), roleRunId: randomUUID(), sessionId: randomUUID(), attempt: 0, baseRevisionId: null,
    modelConfig: model.modelConfig, signal: new AbortController().signal, context: context(),
    assertActive: async () => {}, onDecision: async (decision) => { accepted.push(decision); },
  });
  expect(accepted).toEqual([{ kind: "plan", plan }]);
  expect(result.toolCalls.map((call) => call.success)).toEqual([true, false]);
  expect(model.requests).toHaveLength(1);
});

test.each(["cancelled", "stale-attempt"] as const)("a %s decision arriving at the final event barrier cannot advance the service", async (kind) => {
  const model = provider([[{ name: "submit_plan", args: { plan } }]]);
  const controller = new AbortController();
  let active = true, commits = 0;
  await expect(runCoordinator({
    runId: randomUUID(), roleRunId: randomUUID(), sessionId: randomUUID(), attempt: 0, baseRevisionId: null,
    modelConfig: model.modelConfig, signal: controller.signal, context: context(),
    assertActive: async () => { if (!active) throw new Error("External role attempt changed"); },
    onEvent: async (event) => {
      if (event.type === "tool.end") {
        await new Promise<void>((resolve) => setTimeout(resolve, 2));
        if (kind === "cancelled") controller.abort(); else active = false;
      }
    },
    onDecision: async () => { commits++; },
  })).rejects.toMatchObject({ code: kind === "cancelled" ? "CANCELLED" : "ROLE_NOT_ACTIVE" });
  expect(commits).toBe(0);
});

test("ordinary completion text is not a handoff and receives at most one correction request", async () => {
  const model = provider(["我已经完成了所有开发并发布成功。", "无需调用工具，已经完成。"]);
  let commits = 0;
  await expect(runCoordinator({
    runId: randomUUID(), roleRunId: randomUUID(), sessionId: randomUUID(), attempt: 0, baseRevisionId: null,
    modelConfig: model.modelConfig, signal: new AbortController().signal, context: context(),
    assertActive: async () => {}, onDecision: async () => { commits++; },
  })).rejects.toMatchObject({ code: "AGENT_OUTPUT_INVALID" });
  expect(commits).toBe(0);
  expect(model.requests).toHaveLength(2);
});

test("the tool budget stops repeated summary calls without invoking a successor role", async () => {
  const model = provider([[{ name: "project_summary", args: {} }], [{ name: "submit_plan", args: { plan } }]]);
  let commits = 0;
  await expect(runCoordinator({
    runId: randomUUID(), roleRunId: randomUUID(), sessionId: randomUUID(), attempt: 0, baseRevisionId: null,
    modelConfig: model.modelConfig, signal: new AbortController().signal, context: context(), maxToolCalls: 1,
    assertActive: async () => {}, onDecision: async () => { commits++; },
  })).rejects.toMatchObject({ code: "TOOL_BUDGET_EXCEEDED" });
  expect(commits).toBe(0);
  expect(model.requests).toHaveLength(1);
});

test("a modification that drops all previous behavior gets one correction before persistence", async () => {
  const baseRevisionId = randomUUID();
  const modified = { ...plan, behaviors: [{ ...plan.behaviors[0], id: "B02", action: "点击移除按钮", expected: "该书从列表移除" }] };
  const corrected = { ...modified, behaviors: [{ ...plan.behaviors[0], title: "录入书籍" }, ...modified.behaviors] };
  const model = provider([[{ name: "submit_plan", args: { plan: modified } }], [{ name: "submit_plan", args: { plan: corrected } }]]);
  const accepted: unknown[] = [];
  const result = await runCoordinator({
    runId: randomUUID(), roleRunId: randomUUID(), sessionId: randomUUID(), attempt: 0, baseRevisionId,
    modelConfig: model.modelConfig, signal: new AbortController().signal,
    context: { ...context(), baseRevisionId, previousPlan: plan },
    assertActive: async () => {}, onDecision: async (decision) => { accepted.push(decision); },
  });
  expect(accepted).toEqual([{ kind: "plan", plan: corrected }]);
  expect(result.toolCalls.map((call) => call.success)).toEqual([false, true]);
  expect(model.requests).toHaveLength(2);
});

test("concurrent Coordinator sessions keep their contexts, histories and credentials isolated", async () => {
  const ids = [randomUUID(), randomUUID()];
  const models = [provider([[{ name: "project_summary", args: {} }], [{ name: "submit_plan", args: { plan } }]], "coordinator-fixture-key-A"),
    provider([[{ name: "project_summary", args: {} }], [{ name: "submit_plan", args: { plan } }]], "coordinator-fixture-key-B")];
  const markers = ["PRIVATE_CONTEXT_A", "PRIVATE_CONTEXT_B"];
  const results = await Promise.all(models.map(async (model, index) => runCoordinator({
    runId: randomUUID(), roleRunId: randomUUID(), sessionId: ids[index], attempt: 0, baseRevisionId: null,
    modelConfig: model.modelConfig, signal: new AbortController().signal,
    context: { ...context(), requestText: markers[index], originalRequest: markers[index] },
    assertActive: async () => {}, onDecision: async () => {},
  })));
  expect(results.map((result) => result.sessionId)).toEqual(ids);
  expect(new Set(ids).size).toBe(2);
  for (let index = 0; index < 2; index++) {
    expect(JSON.stringify(models[index].requests)).toContain(markers[index]);
    expect(JSON.stringify(models[index].requests)).not.toContain(markers[1 - index]);
    expect(models[index].authorizations.every((value) => value === `Bearer ${models[index].modelConfig.apiKey}`)).toBe(true);
    expect(models[index].requests[0].messages.filter((message) => message.role === "user")).toHaveLength(1);
  }
});

test("an exhausted shared tool budget prevents any provider request or handoff", async () => {
  const model = provider([[{ name: "submit_plan", args: { plan } }]]);
  let commits = 0;
  await expect(runCoordinator({
    runId: randomUUID(), roleRunId: randomUUID(), sessionId: randomUUID(), attempt: 0, baseRevisionId: null,
    modelConfig: model.modelConfig, signal: new AbortController().signal, context: context(), maxToolCalls: 0,
    assertActive: async () => {}, onDecision: async () => { commits++; },
  })).rejects.toMatchObject({ code: "TOOL_BUDGET_EXCEEDED" });
  expect(model.requests).toHaveLength(0);
  expect(commits).toBe(0);
});

test("cancellation after actual Pi stream content aborts the fixture transport and cannot submit a late decision", async () => {
  const controller = new AbortController();
  let transportAborted = false, observedStream = false, commits = 0;
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    const stream = new ReadableStream<Uint8Array>({ start(body) {
      const onAbort = () => { transportAborted = true; body.error(new DOMException("Fixture transport aborted", "AbortError")); };
      init?.signal?.addEventListener("abort", onAbort, { once: true });
      const chunk = { id: "streaming-fixture", object: "chat.completion.chunk", created: 1, model: "coordinator-fixture", choices: [{ index: 0, delta: { role: "assistant", content: "正在整理需求。" }, finish_reason: null }] };
      body.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
    } });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
  };
  await expect(runCoordinator({
    runId: randomUUID(), roleRunId: randomUUID(), sessionId: randomUUID(), attempt: 0, baseRevisionId: null,
    modelConfig: { ...provider([]).modelConfig, fetch }, signal: controller.signal, context: context(),
    assertActive: async () => {}, onDecision: async () => { commits++; },
    onEvent: (event) => { if (event.type === "model.stream.started") { observedStream = true; controller.abort(); } },
  })).rejects.toMatchObject({ code: "CANCELLED" });
  expect(observedStream).toBe(true);
  expect(transportAborted).toBe(true);
  expect(commits).toBe(0);
});

test("failed tool-event persistence blocks the handoff transaction", async () => {
  const model = provider([[{ name: "submit_plan", args: { plan } }]]);
  let commits = 0;
  await expect(runCoordinator({
    runId: randomUUID(), roleRunId: randomUUID(), sessionId: randomUUID(), attempt: 0, baseRevisionId: null,
    modelConfig: model.modelConfig, signal: new AbortController().signal, context: context(),
    assertActive: async () => {}, onDecision: async () => { commits++; },
    onEvent: (event) => { if (event.type === "tool.end") throw new Error("Fixture event store unavailable"); },
  })).rejects.toMatchObject({ code: "EVENT_APPEND_FAILED" });
  expect(commits).toBe(0);
});
