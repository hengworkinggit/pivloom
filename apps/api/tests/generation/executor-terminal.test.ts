import { expect, test, vi } from "vitest";
import type { RunState } from "@pivloom/contracts";
import { retainsAcceptedPreview, settleTerminalReview } from "../../src/generation/executor.js";

test.each([
  ["completed", true, 0],
  ["failed", false, 1],
  ["needs_changes", false, 1],
] as const)("terminal Reviewer state %s retains only an accepted Preview", async (state, expectedRetained, expectedDestroys) => {
  const repository = { finishReview: vi.fn(async () => ({ run: { state: state as RunState }, repairNextAttempt: null })) };
  const workspace = { destroy: vi.fn(async () => ({ confirmed: true })) };
  const result = await settleTerminalReview(() => repository.finishReview(), () => workspace.destroy());
  expect(repository.finishReview).toHaveBeenCalledTimes(1);
  expect(result.retained).toBe(expectedRetained);
  expect(workspace.destroy).toHaveBeenCalledTimes(expectedDestroys);
  expect(retainsAcceptedPreview(state)).toBe(expectedRetained);
});

test("a repair continuation leaves candidate disposal to the repair branch", async () => {
  const workspace = { destroy: vi.fn(async () => ({ confirmed: true })) };
  const result = await settleTerminalReview(async () => ({ run: { state: "repairing" as RunState }, repairNextAttempt: 1 }),
    () => workspace.destroy());
  expect(result.retained).toBe(false);
  expect(workspace.destroy).not.toHaveBeenCalled();
});
