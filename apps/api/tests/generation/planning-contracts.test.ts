import { expect, test } from "vitest";
import {
  BehaviorAssertionSchema, BehaviorStepSchema, ClarificationQuestionSchema, ClarificationRequestSchema, GroupedPlanSchema,
  MAX_BEHAVIOR_ASSERTIONS, MAX_BEHAVIOR_STEPS, PlanSchema, RoleUsageSchema,
} from "@pivloom/contracts";

test("new clarification requests are one bounded question while historical questions remain readable", () => {
  const historical = "1. 计算公式是什么？\n2. 输入范围是什么？\n3. 需要四舍五入吗？\n4. 需要导出吗？";
  expect(ClarificationQuestionSchema.parse(historical)).toBe(historical);
  expect(ClarificationRequestSchema.parse({ question: "  哪个计算公式必须使用？  " })).toEqual({ question: "哪个计算公式必须使用？" });
  expect(ClarificationRequestSchema.safeParse({ question: "字".repeat(299) + "？" }).success).toBe(true);
  for (const question of [historical, "公式？输入范围？", "公式？请说明", "公式\n输入范围", "公式\u2028输入范围", "字".repeat(301),
    "- 公式", "1. 公式；2. 输入范围", "请确认：1、公式；2、范围", "①公式②输入范围"]) {
    expect(ClarificationRequestSchema.safeParse({ question }).success, question).toBe(false);
  }
});

test("role usage requires bounded named counters and preserves unknown vendor tokens with an explicit source", () => {
  const usage = { modelCalls: 2, toolCalls: 1, inputTokens: 37, outputTokens: null, cachedTokens: null, totalTokens: null, elapsedMs: 1250.5, source: "partial" };
  expect(RoleUsageSchema.parse(usage)).toEqual(usage);
  expect(RoleUsageSchema.safeParse({ ...usage, inputTokens: null, source: "unreported" }).success).toBe(true);
  expect(RoleUsageSchema.safeParse({ ...usage, outputTokens: 9, cachedTokens: 0, totalTokens: 46, source: "reported" }).success).toBe(true);
  for (const invalid of [
    { input: 37, output: null, total: null }, { ...usage, source: "unreported" }, { ...usage, source: "reported" },
    { ...usage, modelCalls: -1 }, { ...usage, toolCalls: 0.5 }, { ...usage, elapsedMs: Infinity },
    { ...usage, cachedTokens: -1 }, { ...usage, rawProviderResponse: { unchecked: true } },
    { ...usage, elapsedMs: undefined },
  ]) expect(RoleUsageSchema.safeParse(invalid).success).toBe(false);
});

const behaviorIds = ["B01", "B02", "B03", "B04", "B05"];
const behavior = (id: string, extra: Record<string, unknown> = {}) => ({
  id, title: `行为 ${id}`, precondition: "页面已打开", action: `执行 ${id}`, expected: `观察 ${id}`, required: true, ...extra,
});
const groupedPlan = (behaviors: Array<Record<string, unknown>>) => ({
  schemaVersion: 2 as const, goal: "计算器", changeSummary: "首版完整验收", assumptions: [], outOfScope: [],
  behaviors,
  groups: [
    { id: "G1", title: "数值运算", behaviorIds: [behaviors[0].id] }, { id: "G2", title: "输入与键盘", behaviorIds: [behaviors[1].id] },
    { id: "G3", title: "错误恢复", behaviorIds: [behaviors[2].id] }, { id: "G4", title: "结果与状态", behaviorIds: [behaviors[3].id] },
    { id: "G5", title: "视觉布局", behaviorIds: [behaviors[4].id] },
  ], replacements: [],
});
const planWith = (first: Record<string, unknown>) =>
  GroupedPlanSchema.safeParse(groupedPlan(behaviorIds.map((id, index) => behavior(id, index === 0 ? first : {}))));

test("executable verification is optional, so a prose-only plan validates exactly as before", () => {
  const prose = groupedPlan(behaviorIds.map((id) => behavior(id)));
  expect(PlanSchema.safeParse(prose).success).toBe(true);
  expect(GroupedPlanSchema.parse(prose).behaviors[0]).toEqual(behavior("B01"));
  expect(Object.keys(GroupedPlanSchema.parse(prose).behaviors[0]))
    .toEqual(["id", "title", "precondition", "action", "expected", "required"]);
});

test("a plan carries replayable steps and the five checks a script can decide without a model", () => {
  const parsed = planWith({
    steps: [{ type: "open" }, { type: "reload" }, { type: "resize", width: 390, height: 844 },
      { type: "click", name: "添加" }, { type: "fill", name: "书名", text: "三体" },
      { type: "select", name: "分类", value: "科幻" }, { type: "press", key: "Enter" },
      { type: "wait", ms: 200 }, { type: "capture" }],
    assertions: [{ kind: "text", text: "已添加" }, { kind: "text", text: "错误", negated: true },
      { kind: "control", role: "button", name: "添加" }, { kind: "control", role: "button", name: "清空", negated: true },
      { kind: "console-error", negated: true }],
    evidence: "visual",
  });
  expect(parsed.success).toBe(true);
  expect(parsed.success && parsed.data.behaviors[0]).toMatchObject({
    evidence: "visual",
    steps: [{ type: "open", path: "/" }, { type: "reload" }, { type: "resize", width: 390, height: 844 },
      { type: "click", role: "button", name: "添加" }, { type: "fill", role: "button", name: "书名", text: "三体" },
      { type: "select", role: "button", name: "分类", value: "科幻" }, { type: "press", key: "Enter" },
      { type: "wait", ms: 200 }, { type: "capture" }],
    assertions: [{ kind: "text", text: "已添加", negated: false }, { kind: "text", text: "错误", negated: true },
      { kind: "control", role: "button", name: "添加", negated: false },
      { kind: "control", role: "button", name: "清空", negated: true }, { kind: "console-error", negated: true }],
  });
  // Both fields compile to closed unions, so one behavior can also be verified
  // on its own without the plan context.
  expect(BehaviorStepSchema.safeParse({ type: "press", key: "ArrowDown" }).success).toBe(true);
  expect(BehaviorAssertionSchema.safeParse({ kind: "console-error" }).success).toBe(true);
});

test("only replay operations and assertions the browser layer can decide are accepted", () => {
  for (const step of [{ type: "open" }, { type: "reload" }, { type: "capture" }])
    expect(planWith({ steps: [step] }).success, JSON.stringify(step)).toBe(true);
  // A type the replay cannot execute, a control located by something other than
  // role+name, and out-of-range primitives are refused at planning time.
  for (const step of [{ type: "hover", name: "添加" }, { type: "click" }, { type: "click", name: "添加", selector: "#add" },
    { type: "fill", name: "书名" }, { type: "press", key: "F5" }, { type: "wait", ms: 0 },
    { type: "resize", width: 100, height: 100 }])
    expect(planWith({ steps: [step] }).success, JSON.stringify(step)).toBe(false);
  for (const assertions of [[{ kind: "url-matches", text: "/done" }], [{ kind: "text" }], [{ kind: "console-error", text: "x" }]])
    expect(planWith({ assertions }).success, JSON.stringify(assertions)).toBe(false);
  expect(planWith({ evidence: "pixel" }).success).toBe(false);
});

test("step and assertion arrays stay bounded while the plan byte cap remains the binding limit", () => {
  expect(planWith({ steps: Array.from({ length: MAX_BEHAVIOR_STEPS }, () => ({ type: "reload" })) }).success).toBe(true);
  expect(planWith({ steps: Array.from({ length: MAX_BEHAVIOR_STEPS + 1 }, () => ({ type: "reload" })) }).success).toBe(false);
  expect(planWith({ assertions: Array.from({ length: MAX_BEHAVIOR_ASSERTIONS }, () => ({ kind: "console-error" })) }).success).toBe(true);
  expect(planWith({ assertions: Array.from({ length: MAX_BEHAVIOR_ASSERTIONS + 1 }, () => ({ kind: "console-error" })) }).success).toBe(false);
});

test("the plan ceiling leaves room for compiled steps without removing the bound", () => {
  const bulk = (chars: number) => {
    const behaviors = Array.from({ length: 80 }, (_, index) => behavior(`B${String(index + 1).padStart(2, "0")}`, { precondition: "前".repeat(chars) }));
    const chunk = (from: number) => behaviors.slice(from, from + 16).map((item) => item.id);
    return { ...groupedPlan(behaviors), groups: [
      { id: "G1", title: "数值运算", behaviorIds: chunk(0) }, { id: "G2", title: "输入与键盘", behaviorIds: chunk(16) },
      { id: "G3", title: "错误恢复", behaviorIds: chunk(32) }, { id: "G4", title: "结果与状态", behaviorIds: chunk(48) },
      { id: "G5", title: "视觉布局", behaviorIds: chunk(64) },
    ] };
  };
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
  // Executable fields pushed a realistic plan past the old 64 KiB ceiling; the
  // raise is bounded and an oversized plan is still refused.
  expect(bytes(bulk(290))).toBeGreaterThan(64 * 1024);
  expect(bytes(bulk(290))).toBeLessThan(96 * 1024);
  expect(GroupedPlanSchema.safeParse(bulk(290)).success).toBe(true);
  expect(GroupedPlanSchema.safeParse(bulk(500)).success).toBe(false);
});
