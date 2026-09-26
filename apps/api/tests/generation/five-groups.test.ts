import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { CheckSchema, GroupedPlanSchema, PlanSchema, ReviewResultSchema, aggregateCheckGroups, preservesPreviousBehavior } from "@pivloom/contracts";

const behavior = (id: string) => ({ id, title: `目标 ${id}`, precondition: "页面已打开", action: `执行 ${id}`,
  expected: `观察 ${id} 结果`, required: true });
const base = {
  schemaVersion: 2 as const, goal: "计算器", changeSummary: "首版完整验收", assumptions: [], outOfScope: [],
  behaviors: ["B01", "B02", "B03", "B04", "B05", "B06"].map(behavior),
  groups: [
    { id: "G1", title: "数值运算", behaviorIds: ["B01", "B02"] },
    { id: "G2", title: "输入与键盘", behaviorIds: ["B03"] },
    { id: "G3", title: "错误恢复", behaviorIds: ["B04"] },
    { id: "G4", title: "结果与历史", behaviorIds: ["B05"] },
    { id: "G5", title: "视觉布局", behaviorIds: ["B06"] },
  ], replacements: [],
};

test("new plans have five stable groups covering every required child exactly once while legacy flat plans remain readable", () => {
  expect(GroupedPlanSchema.safeParse(base).success).toBe(true);
  expect(PlanSchema.safeParse({ schemaVersion: 1, goal: "历史", changeSummary: "历史", assumptions: [], outOfScope: [],
    behaviors: [behavior("B01")] }).success).toBe(true);
  expect(GroupedPlanSchema.safeParse({ ...base, groups: base.groups.slice(0, 4) }).success).toBe(false);
  expect(GroupedPlanSchema.safeParse({ ...base, groups: base.groups.map((group) => group.id === "G2"
    ? { ...group, behaviorIds: ["B02", "B03"] } : group) }).success).toBe(false);
  expect(GroupedPlanSchema.safeParse({ ...base, behaviors: base.behaviors.filter((item) => item.id !== "B02") }).success).toBe(false);
  expect(GroupedPlanSchema.safeParse({ ...base, groups: base.groups.map((group) => group.id === "G5"
    ? { ...group, behaviorIds: ["B99"] } : group) }).success).toBe(false);
});

test("all previous required IDs and observable meanings survive an increment; replacement needs a new ID and quoted user change", () => {
  const previous = GroupedPlanSchema.parse(base);
  const added = { ...base, behaviors: [...base.behaviors, behavior("B07")],
    groups: base.groups.map((group) => group.id === "G4" ? { ...group, behaviorIds: [...group.behaviorIds, "B07"] } : group) };
  expect(preservesPreviousBehavior(GroupedPlanSchema.parse(added), previous, "新增历史清空按钮")).toBe(true);
  const omitted = { ...added, behaviors: added.behaviors.filter((item) => item.id !== "B02"),
    groups: added.groups.map((group) => ({ ...group, behaviorIds: group.behaviorIds.filter((id) => id !== "B02") })) };
  expect(preservesPreviousBehavior(GroupedPlanSchema.parse(omitted), previous, "新增历史清空按钮")).toBe(false);
  const redefined = { ...base, behaviors: base.behaviors.map((item) => item.id === "B02" ? { ...item, expected: "另一种结果" } : item) };
  expect(preservesPreviousBehavior(GroupedPlanSchema.parse(redefined), previous, "改颜色")).toBe(false);
  const movedGroup = { ...base, groups: base.groups.map((group) => group.id === "G1"
    ? { ...group, behaviorIds: ["B01"] } : group.id === "G2"
      ? { ...group, behaviorIds: ["B02", "B03"] } : group) };
  expect(preservesPreviousBehavior(GroupedPlanSchema.parse(movedGroup), previous, "新增历史清空按钮")).toBe(false);
  const renamedGroup = { ...base, groups: base.groups.map((group) => group.id === "G1" ? { ...group, title: "无关的新组" } : group) };
  expect(preservesPreviousBehavior(GroupedPlanSchema.parse(renamedGroup), previous, "新增历史清空按钮")).toBe(false);
  const replacement = { ...omitted,
    groups: omitted.groups.map((group) => group.id === "G1" ? { ...group, behaviorIds: [...group.behaviorIds, "B07"] }
      : { ...group, behaviorIds: group.behaviorIds.filter((id) => id !== "B07") }),
    replacements: [{ oldBehaviorId: "B02", newBehaviorId: "B07", userRequestQuote: "把金额改为两位小数", reason: "用户明确改了金额表示" }],
  };
  const next = GroupedPlanSchema.parse(replacement);
  expect(preservesPreviousBehavior(next, previous, "把金额改为两位小数")).toBe(true);
  expect(preservesPreviousBehavior(next, previous, "新增历史清空按钮")).toBe(false);
  const reuseRetiredId = GroupedPlanSchema.parse({ ...next, replacements: [],
    behaviors: [...next.behaviors, { ...behavior("B02"), expected: "新的无关含义" }],
    groups: next.groups.map((group) => group.id === "G1" ? { ...group, behaviorIds: [...group.behaviorIds, "B02"] } : group) });
  expect(preservesPreviousBehavior(reuseRetiredId, next, "增加无关的新按钮")).toBe(false);
  expect(preservesPreviousBehavior(next, next, "新增另一功能")).toBe(true);
  const chained = GroupedPlanSchema.parse({ ...next,
    behaviors: [...next.behaviors.filter((item) => item.id !== "B07"), behavior("B08")],
    groups: next.groups.map((group) => ({ ...group, behaviorIds: group.behaviorIds.map((id) => id === "B07" ? "B08" : id) })),
    replacements: [...next.replacements, { oldBehaviorId: "B07", newBehaviorId: "B08",
      userRequestQuote: "把金额改为整数", reason: "用户再次改变金额表示" }],
  });
  expect(preservesPreviousBehavior(chained, next, "把金额改为整数")).toBe(true);
  const invented = GroupedPlanSchema.parse({ ...added, replacements: [{ oldBehaviorId: "B99", newBehaviorId: "B07",
    userRequestQuote: "把金额改为两位小数", reason: "伪造旧要求" }] });
  expect(preservesPreviousBehavior(invented, previous, "把金额改为两位小数")).toBe(false);
  expect(preservesPreviousBehavior(invented, null, "把金额改为两位小数")).toBe(false);
  expect(preservesPreviousBehavior(GroupedPlanSchema.parse({ ...replacement,
    replacements: [{ ...replacement.replacements[0], newBehaviorId: "B01" }] }), previous, "把金额改为两位小数")).toBe(false);
});

test("compiling a preserved behavior into steps or assertions is verification, never a semantic change", () => {
  const previous = GroupedPlanSchema.parse(base);
  const compiled = GroupedPlanSchema.parse({ ...base, behaviors: base.behaviors.map((item) => item.id === "B01"
    ? { ...item, steps: [{ type: "open" }, { type: "click", name: "添加" }, { type: "capture" }],
        assertions: [{ kind: "control", name: "添加" }, { kind: "text", text: "已添加" }], evidence: "text" }
    : item) });
  expect(preservesPreviousBehavior(compiled, previous, "")).toBe(true);
  // Refining an existing program is equally free: rebuilding the same promise
  // with a sharper check must not retire a behavior the user never changed.
  const refined = GroupedPlanSchema.parse({ ...compiled, behaviors: compiled.behaviors.map((item) => item.id === "B01"
    ? { ...item, steps: [{ type: "open", path: "/" }, { type: "fill", name: "书名", text: "三体" }, { type: "capture" }],
        assertions: [{ kind: "console-error", negated: true }], evidence: "visual" }
    : item) });
  expect(preservesPreviousBehavior(refined, compiled, "")).toBe(true);
  // The prose fields stay authoritative: a stricter assertion cannot justify
  // moving what the user was promised.
  for (const changed of [{ expected: "另一种结果" }, { action: "另一种动作" }, { precondition: "另一种前提" }, { required: false }]) {
    const mutated = GroupedPlanSchema.parse({ ...refined, behaviors: refined.behaviors.map((item) => item.id === "B01" ? { ...item, ...changed } : item) });
    expect(preservesPreviousBehavior(mutated, previous, "改颜色"), JSON.stringify(changed)).toBe(false);
  }
  const compensated = GroupedPlanSchema.parse({ ...compiled, behaviors: compiled.behaviors.map((item) => item.id === "B01"
    ? { ...item, expected: "别的结果", assertions: [{ kind: "text", text: "别的结果" }] } : item) });
  expect(preservesPreviousBehavior(compensated, previous, "")).toBe(false);
});

test("server group aggregate cannot call a failed, blocked or missing child 5/5", () => {
  const plan = GroupedPlanSchema.parse(base);
  const ids = plan.behaviors.map((item) => item.id);
  const items = ids.map((behaviorId) => ({ behaviorId, verdict: "passed" as const,
    expected: plan.behaviors.find((item) => item.id === behaviorId)!.expected,
    actual: "实际操作与截图均通过", observationEventIds: [randomUUID()], screenshotIds: [], reproSteps: [] }));
  expect(ReviewResultSchema.safeParse({ revisionId: "00000000-0000-4000-8000-000000000001",
    sourceHash: "a".repeat(64), items, summary: "六项均通过" }).success).toBe(true);
  expect(aggregateCheckGroups(plan, items).filter((group) => group.verdict === "passed")).toHaveLength(5);
  expect(aggregateCheckGroups(plan, items.map((item) => item.behaviorId === "B02" ? { ...item, verdict: "failed" as const } : item))
    .map((group) => group.verdict)).toEqual(["failed", "passed", "passed", "passed", "passed"]);
  expect(aggregateCheckGroups(plan, items.map((item) => item.behaviorId === "B06" ? { ...item, verdict: "blocked" as const } : item))
    .map((group) => group.verdict)).toEqual(["passed", "passed", "passed", "passed", "blocked"]);
  expect(aggregateCheckGroups(plan, items.map((item) => item.behaviorId === "B01" ? { ...item, observationEventIds: [] } : item))
    .map((group) => group.verdict)).toEqual(["blocked", "passed", "passed", "passed", "passed"]);
  expect(() => aggregateCheckGroups(plan, items.filter((item) => item.behaviorId !== "B06"))).toThrow();
  const groupedCheck = { id: randomUUID(), runId: randomUUID(), roleRunId: randomUUID(), attempt: 0,
    revisionId: randomUUID(), sourceHash: "a".repeat(64), sandboxId: "fixture-sandbox", browserSessionId: "fixture-session",
    verdict: "passed", items, groups: aggregateCheckGroups(plan, items), summary: "六项通过", artifacts: [], createdAt: new Date().toISOString() };
  expect(CheckSchema.safeParse(groupedCheck).success).toBe(true);
  expect(CheckSchema.safeParse({ ...groupedCheck, groups: groupedCheck.groups.map((group) => group.id === "G1"
    ? { ...group, passedCount: 1 } : group) }).success).toBe(false);
  expect(CheckSchema.safeParse({ ...groupedCheck, items: items.map((item) => item.behaviorId === "B02"
    ? { ...item, verdict: "failed" } : item) }).success).toBe(false);
});
