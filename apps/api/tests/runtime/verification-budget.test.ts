import { expect, test } from 'vitest';
import { generationToolLimitForPlan, reviewToolLimitForPlan } from '../../src/runtime/budgets.js';

test('a 45-behavior run can fund its initial review and both permitted repair reviews', () => {
  // The Builder's executable cap is 80. Each of these three 45-behavior reviews
  // needs the existing 360-call allowance, including the normal repair path.
  const limit = generationToolLimitForPlan(45);
  let remaining = limit - 12;
  for (let attempt = 0; attempt < 3; attempt++) {
    remaining -= 80;
    expect(Math.min(reviewToolLimitForPlan(45), remaining)).toBeGreaterThanOrEqual(360);
    remaining -= 360;
  }
  expect(limit).toBeLessThanOrEqual(2052);
  expect(remaining).toBeGreaterThanOrEqual(0);
});

test('the largest supported plan has a finite shared run allowance', () => {
  expect(generationToolLimitForPlan(80)).toBe(2052);
  expect(reviewToolLimitForPlan(80)).toBe(600);
});
