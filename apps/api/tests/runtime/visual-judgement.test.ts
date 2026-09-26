import { expect, test, vi } from "vitest";
import { judgeVisualBehaviours, type VisualJudgementBehaviour } from "../../src/runtime/visual-judgement.js";

const image = { base64: "iVBORw0KGgo=", mimeType: "image/png" };
const behaviour = (overrides: Partial<VisualJudgementBehaviour> = {}): VisualJudgementBehaviour => ({
  id: "B07", expected: "结算区域显示金额 12.00 且靠右对齐", images: [image], ...overrides,
});
const reply = (judgements: unknown) => JSON.stringify({ judgements });
const input = (overrides: Partial<Parameters<typeof judgeVisualBehaviours>[0]> = {}) => ({
  behaviours: [behaviour()], request: vi.fn(async () => reply([])), deadlineMs: 480_000, now: () => 0, ...overrides,
});

test("a model that quotes what it saw passes the behaviour", async () => {
  // The direction that keeps this layer worth having: if a capable model could never pass, every
  // visual plan would fail and the layer would buy nothing while looking safe.
  const request = vi.fn(async () => reply([{ id: "B07", verdict: "passed", citation: "右侧金额显示 12.00 元" }]));
  const judged = await judgeVisualBehaviours(input({ request }));
  expect(judged.get("B07")).toEqual({ verdict: "passed", reason: "右侧金额显示 12.00 元" });
  expect(request).toHaveBeenCalledTimes(1);
});

test("restating the expectation is not evidence and cannot pass", async () => {
  const request = vi.fn(async () => reply([{ id: "B07", verdict: "passed", citation: "结算区域显示金额 12.00 且靠右对齐" }]));
  const judged = await judgeVisualBehaviours(input({ request }));
  expect(judged.get("B07")).toMatchObject({ verdict: "blocked", reason: "uncited" });
});

test("an unparseable answer and a missing entry both block rather than pass", async () => {
  const unparseable = await judgeVisualBehaviours(input({ request: async () => "I think it looks fine." }));
  expect(unparseable.get("B07")).toMatchObject({ verdict: "blocked", reason: "unparseable" });
  const missing = await judgeVisualBehaviours(input({ request: async () => reply([{ id: "B99", verdict: "passed", citation: "12.00" }]) }));
  expect(missing.get("B07")).toMatchObject({ verdict: "blocked", reason: "missing-entry" });
});

test("a behaviour with no captured image cannot be judged from pixels", async () => {
  const request = vi.fn(async () => reply([{ id: "B07", verdict: "passed", citation: "右侧 12.00" }]));
  const judged = await judgeVisualBehaviours(input({ behaviours: [behaviour({ images: [] })], request }));
  expect(judged.get("B07")).toMatchObject({ verdict: "blocked", reason: "no-image" });
});

test("with the budget gone nothing is asked and everything blocks", async () => {
  const request = vi.fn(async () => reply([{ id: "B07", verdict: "passed", citation: "右侧 12.00" }]));
  const judged = await judgeVisualBehaviours(input({ request, deadlineMs: 0, now: () => 1 }));
  expect(judged.get("B07")).toMatchObject({ verdict: "blocked", reason: "budget" });
  // The point of checking first: an over-budget judgement must not spend a request at all.
  expect(request).not.toHaveBeenCalled();
});
