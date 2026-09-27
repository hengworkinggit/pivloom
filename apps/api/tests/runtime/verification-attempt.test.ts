import { expect, test } from 'vitest';
import { createVerificationAttemptWindow } from '../../src/runtime/verification-attempt.js';
import { VERIFICATION_ATTEMPT_TIMEOUT_MS } from '../../src/runtime/budgets.js';

test('a legitimately routed next attempt receives its own safety window after a long progressing run', () => {
  let monotonic = 0;
  const wallStart = Date.UTC(2026, 8, 27);
  const options = { now: () => monotonic, wallNow: () => wallStart + monotonic };
  const first = createVerificationAttemptWindow(options);
  expect(first).toEqual({ startedAt: 0, deadlineAt: 600_000, startedAtWall: wallStart });
  monotonic = 720_000;
  const next = createVerificationAttemptWindow(options);
  expect(next).toEqual({ startedAt: 720_000, deadlineAt: 1_320_000, startedAtWall: wallStart + 720_000 });
  expect(next.deadlineAt - next.startedAt).toBe(VERIFICATION_ATTEMPT_TIMEOUT_MS);
  // Old evidence and a fallback in that old attempt retain the original window.
  expect(first.deadlineAt).toBe(600_000);
  expect(Object.isFrozen(first)).toBe(true);
});

test('attempt duration can be bounded explicitly without a global run stopwatch or minimum repair count', () => {
  const window = createVerificationAttemptWindow({ now: () => 1_234.5, wallNow: () => 10_000, timeoutMs: 30_000 });
  expect(window).toEqual({ startedAt: 1_234.5, deadlineAt: 31_234.5, startedAtWall: 10_000 });
});

test.each([0, -1, NaN, Infinity, 1.5, 2_147_483_648])('invalid per-attempt timer duration %s is rejected rather than disabling safety', timeoutMs => {
  expect(() => createVerificationAttemptWindow({ timeoutMs })).toThrow(RangeError);
});
