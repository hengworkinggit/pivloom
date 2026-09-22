import { expect, test } from "vitest";
import { ClarificationQuestionSchema, ClarificationRequestSchema, RoleUsageSchema } from "@pivloom/contracts";

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
