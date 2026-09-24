import { afterEach, expect, test, vi } from 'vitest';
import { createRunProgressWatchdog } from '../../src/generation/progress-watchdog.js';
import { RUN_IDLE_TIMEOUT_MS } from '../../src/runtime/budgets.js';

afterEach(() => vi.useRealTimers());

test('a run can make real progress for more than the old 30-minute ceiling', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-24T00:00:00.000Z'));
  const controller = new AbortController();
  const started = Date.now();
  const watchdog = createRunProgressWatchdog(
    new Date(Date.now() + RUN_IDLE_TIMEOUT_MS).toISOString(), controller,
  );
  for (let turn = 0; turn < 8; turn++) {
    await vi.advanceTimersByTimeAsync(RUN_IDLE_TIMEOUT_MS - 1_000);
    expect(controller.signal.aborted).toBe(false);
    watchdog.touch(new Date(Date.now() + RUN_IDLE_TIMEOUT_MS).toISOString());
  }
  expect(Date.now() - started).toBeGreaterThan(30 * 60_000);
  expect(controller.signal.aborted).toBe(false);
  watchdog.close();
});

test('a run with no progress stops after its inactivity lease', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-24T00:00:00.000Z'));
  const controller = new AbortController();
  const watchdog = createRunProgressWatchdog(
    new Date(Date.now() + RUN_IDLE_TIMEOUT_MS).toISOString(), controller,
  );
  await vi.advanceTimersByTimeAsync(RUN_IDLE_TIMEOUT_MS - 1);
  expect(controller.signal.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(controller.signal.aborted).toBe(true);
  expect(controller.signal.reason).toBe('RUN_TIMEOUT');
  watchdog.close();
});
