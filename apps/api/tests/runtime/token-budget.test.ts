import { expect, test } from "vitest";
import { createRunTokenBudget } from "../../src/runtime/token-budget.js";

test("the production run ledger records usage without a cumulative token limit", () => {
  const budget = createRunTokenBudget();
  budget.reserve(2_000_000, 10_000).settle();
  budget.reserve(2_000_000, 10_000).settle();
  expect(budget.snapshot()).toEqual({ limitTokens: null, accountedTokens: 4_020_000,
    remainingTokens: null, requests: 2, pendingRequests: 0, unreportedRequests: 2 });
});

test("an explicit test budget still rejects reservations beyond its limit", () => {
  const limit = 400_000;
  const budget = createRunTokenBudget(limit);
  const first = budget.reserve(60_000, 40_000);
  first.settle();
  const second = budget.reserve(limit - 105_000, 5_000);
  second.settle({ input: limit - 105_000, output: 5_000, cacheRead: 0, cacheWrite: 0, totalTokens: limit - 100_000 });
  expect(budget.snapshot()).toEqual({ limitTokens: limit, accountedTokens: limit,
    remainingTokens: 0, requests: 2, pendingRequests: 0, unreportedRequests: 1 });
  expect(() => budget.reserve(1, 1)).toThrowError(expect.objectContaining({ code: "TOKEN_BUDGET_EXCEEDED" }));
  expect(() => createRunTokenBudget(0)).toThrowError(expect.objectContaining({ code: "TOKEN_BUDGET_INVALID" }));
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
