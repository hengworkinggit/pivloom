import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { GroupedPlanSchema, LegacyPlanSchema } from "@pivloom/contracts";
import { GenerationPlan } from "./generation-plan";

const atom = (id: string) => ({ id, title: `检查 ${id}`, precondition: "页面打开", action: `操作 ${id}`,
  expected: `观察 ${id}`, required: true });

test("new plan shows all five named groups and every child; historical flat plan keeps its original label", () => {
  const grouped = GroupedPlanSchema.parse({ schemaVersion: 2, goal: "计算器", changeSummary: "可操作的计算器", assumptions: [], outOfScope: [],
    behaviors: ["B01", "B02", "B03", "B04", "B05", "B06"].map(atom),
    groups: [
      { id: "G1", title: "数值运算", behaviorIds: ["B01", "B02"] },
      { id: "G2", title: "输入键盘", behaviorIds: ["B03"] },
      { id: "G3", title: "错误恢复", behaviorIds: ["B04"] },
      { id: "G4", title: "历史状态", behaviorIds: ["B05"] },
      { id: "G5", title: "视觉布局", behaviorIds: ["B06"] },
    ], replacements: [] });
  const newHtml = renderToStaticMarkup(<GenerationPlan plan={grouped} />);
  expect(newHtml).toContain("五组完整目标");
  expect(newHtml).toContain("6 项子检查");
  for (const title of ["数值运算", "输入键盘", "错误恢复", "历史状态", "视觉布局"])
    expect(newHtml).toContain(title);
  for (const id of ["B01", "B02", "B03", "B04", "B05", "B06"]) expect(newHtml).toContain(id);
  const old = LegacyPlanSchema.parse({ schemaVersion: 1, goal: "旧报名页", changeSummary: "表单", assumptions: [], outOfScope: [], behaviors: [atom("B01")] });
  const oldHtml = renderToStaticMarkup(<GenerationPlan plan={old} />);
  expect(oldHtml).toContain("历史平铺目标 · 1 项");
  expect(oldHtml).not.toContain("五组完整目标");
});
