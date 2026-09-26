import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
import type { Run, RunFailureDetail } from "@pivloom/contracts";
import { GenerationOutcome } from "./generation-activity";

vi.mock("@/lib/ui-preferences", () => ({ useUiPreferences: () => ({ text: (zh: string) => zh }) }));

// Only the fields this component reads; a full Run would say nothing more about the rendering.
const run = {
  id: "0f6c1d2e-6a11-4f5b-9d3a-2b7c8e4f1a20", state: "failed", phase: "cleanup", attempt: 0,
  modelConfigVersion: 1, modelId: "test-model",
  error: { code: "GENERATION_FAILED", message: "生成或保存未完成，请稍后重试。", retryable: true },
} as unknown as Run;

const record = (detail: Record<string, unknown>): RunFailureDetail => ({
  phase: "review", code: "GENERATION_FAILED", causeClass: "SCHEMA_VALIDATION", detail,
  createdAt: new Date("2026-09-26T00:39:10Z").toISOString(),
});

test("a classified failure shows its real cause instead of only the generic message", () => {
  // The evidence cap that ended a C3 run: the run stored only "生成或保存未完成" while the
  // cause sat on the server console, so the check appeared unreproducible. The recorded
  // issue must now reach the run detail itself.
  const html = renderToStaticMarkup(<GenerationOutcome run={run} candidateSaved={false}
    failureDetail={record({ issues: [JSON.stringify({ origin: "array", code: "too_big", maximum: 256, path: [], message: "Too big: expected array to have <=256 items" })] })} />);
  expect(html).toContain("真实原因");
  expect(html).toContain("SCHEMA_VALIDATION");
  expect(html).toContain("Too big: expected array to have &lt;=256 items");
  // The generic sentence stays as the user-facing line; the cause is additional, not a replacement.
  expect(html).toContain("生成或保存未完成");
});

test("a runtime failure reports its own code and message", () => {
  const html = renderToStaticMarkup(<GenerationOutcome run={run} candidateSaved={false}
    failureDetail={{ ...record({ code: "TOOL_BUDGET_EXCEEDED", message: "本次任务的工具调用预算已耗尽。" }), causeClass: "RUNTIME" }} />);
  expect(html).toContain("RUNTIME");
  expect(html).toContain("TOOL_BUDGET_EXCEEDED");
});

test("without a recorded cause the outcome keeps its previous shape", () => {
  const html = renderToStaticMarkup(<GenerationOutcome run={run} candidateSaved={false} failureDetail={null} />);
  expect(html).not.toContain("真实原因");
  expect(html).toContain("生成或保存未完成");
});
