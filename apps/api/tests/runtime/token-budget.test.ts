import { expect, test } from "vitest";
import { createRunTokenBudget } from "../../src/runtime/token-budget.js";
import { RUN_TOKEN_LIMIT } from "../../src/runtime/budgets.js";

test(`the calibrated run budget allows ${RUN_TOKEN_LIMIT.toLocaleString("en-US")} tokens and rejects any new reservation beyond that limit`, () => {
  const budget = createRunTokenBudget();
  const first = budget.reserve(60_000, 40_000);
  first.settle();
  const second = budget.reserve(RUN_TOKEN_LIMIT - 105_000, 5_000);
  second.settle({ input: RUN_TOKEN_LIMIT - 105_000, output: 5_000, cacheRead: 0, cacheWrite: 0, totalTokens: RUN_TOKEN_LIMIT - 100_000 });
  expect(budget.snapshot()).toEqual({ limitTokens: RUN_TOKEN_LIMIT, accountedTokens: RUN_TOKEN_LIMIT,
    remainingTokens: 0, requests: 2, pendingRequests: 0, unreportedRequests: 1 });
  expect(() => budget.reserve(1, 1)).toThrowError(expect.objectContaining({ code: "TOKEN_BUDGET_EXCEEDED" }));
  expect(() => createRunTokenBudget(RUN_TOKEN_LIMIT + 1)).toThrowError(expect.objectContaining({ code: "TOKEN_BUDGET_INVALID" }));
});

test("requests reserve the run's shared capacity before starting and settle cache-inclusive usage once", () => {
  const budget = createRunTokenBudget(100);
  const first = budget.reserve(40, 30);
  expect(() => budget.reserve(20, 20)).toThrowError(/预算/);
  first.settle({ input: 5, output: 10, cacheRead: 20, cacheWrite: 5, totalTokens: 40 });
  first.settle({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 });
  expect(budget.snapshot().accountedTokens).toBe(40);
  budget.reserve(30, 30);
  expect(budget.snapshot()).toMatchObject({ limitTokens: 100, accountedTokens: 100, remainingTokens: 0, requests: 2, pendingRequests: 1 });
});

test("missing usage keeps its full reservation and in-flight usage above the estimate blocks further requests", () => {
  const budget = createRunTokenBudget(100);
  const unknown = budget.reserve(30, 20);
  expect(unknown.settle()).toEqual({ input: null, output: null, total: null, cachedTokens: null });
  expect(budget.snapshot()).toMatchObject({ accountedTokens: 50, pendingRequests: 0, unreportedRequests: 1 });
  const lateUsage = budget.reserve(20, 30);
  lateUsage.settle({ input: 50, output: 25, cacheRead: 0, cacheWrite: 0, totalTokens: 75 });
  expect(budget.snapshot()).toMatchObject({ accountedTokens: 125, remainingTokens: 0 });
  expect(() => budget.reserve(1, 1)).toThrowError(/预算/);
});
