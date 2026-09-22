import { expect, it } from "vitest";
import { CheckSchema, ReviewResultSchema } from "@pivloom/contracts";

function reportAtLimit() {
  return {
    revisionId: "09d00eb6-661f-4ed7-9e96-a46f4e2c800e", sourceHash: "a".repeat(64),
    items: Array.from({ length: 5 }, (_, index) => ({
      behaviorId: `B0${index + 1}`, verdict: "blocked", expected: "预".repeat(1000), actual: "实".repeat(1000),
      observationEventIds: [], screenshotIds: [], reproSteps: Array.from({ length: 8 }, () => "步".repeat(148)),
    })),
    // Worked UTF-8 fixture: 48,673 bytes before this 479-byte ASCII suffix.
    summary: "fixture" + "x".repeat(479),
  };
}

it("accepts a 48 KiB UTF-8 report and rejects the next byte before persistence", () => {
  const allowed = reportAtLimit();
  const oversized = { ...allowed, summary: allowed.summary + "x" };
  expect(new TextEncoder().encode(JSON.stringify(allowed))).toHaveLength(49_152);
  expect(new TextEncoder().encode(JSON.stringify(oversized))).toHaveLength(49_153);
  expect(ReviewResultSchema.safeParse(allowed).success).toBe(true);
  expect(ReviewResultSchema.safeParse(oversized).success).toBe(false);
});

it("keeps larger previously saved check items readable within the existing storage limit", () => {
  const report = reportAtLimit();
  report.items[0].expected = "预".repeat(2000);
  const saved = {
    ...report, id: "29b07531-d902-4fa0-b1b8-65d52c908cbb", runId: "74b24d87-1342-4d43-8c4e-f82e766a0633",
    roleRunId: "e861ce71-b069-44df-b13b-7c462265d8ee", attempt: 0, sandboxId: "fixture-sandbox",
    browserSessionId: "fixture-review-session", verdict: "blocked", artifacts: [], createdAt: "2026-09-22T00:00:00.000Z",
  };
  expect(CheckSchema.safeParse(saved).success).toBe(true);
});
