import { afterEach, expect, test, vi } from 'vitest';
import { createMeaningfulProgressGate, createRunProgressWatchdog } from '../../src/generation/progress-watchdog.js';
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

test('read-only polls and failed actions cannot keep a Reviewer run alive', () => {
  const progress = createMeaningfulProgressGate();
  const role = 'reviewer-role';
  expect(progress(role, { type:'model.stream.started', success:true, message:'actual first delta' })).toBe(true);
  expect(progress(role, { type:'model.stream.started', success:true, message:'another delta' })).toBe(false);
  for (const toolName of ['browser_observe','browser_logs','source_read','observation_read','screenshot_read','browser_screenshot']) {
    expect(progress(role, { type:'tool.end', toolName, success:true, message:'read completed' })).toBe(false);
  }
  expect(progress(role, { type:'tool.end', toolName:'browser_click', success:false, message:'click failed' })).toBe(false);
  expect(progress(role, { type:'tool.end', toolName:'browser_click', success:true, message:'clicked' })).toBe(true);
  expect(progress(role, { type:'tool.end', toolName:'record_behavior', success:true, message:'recorded' })).toBe(true);
  expect(progress('builder-role', { type:'tool.end', toolName:'write', success:true, message:'source saved' })).toBe(true);
});

test('repeated read-only model turns cannot outlive the rolling inactivity lease', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-24T00:00:00.000Z'));
  const controller = new AbortController();
  const watchdog = createRunProgressWatchdog(new Date(Date.now() + RUN_IDLE_TIMEOUT_MS).toISOString(), controller);
  const progress = createMeaningfulProgressGate();
  for (let turn = 0; turn < 12 && !controller.signal.aborted; turn++) {
    await vi.advanceTimersByTimeAsync(60_000);
    if (progress('reviewer-role', { type:'model.stream.started', success:true, message:'nonempty delta' }))
      watchdog.touch(new Date(Date.now() + RUN_IDLE_TIMEOUT_MS).toISOString());
    expect(progress('reviewer-role', { type:'tool.end', toolName:'browser_observe', success:true, message:'poll' })).toBe(false);
  }
  expect(controller.signal.aborted).toBe(true);
  expect(controller.signal.reason).toBe('RUN_TIMEOUT');
  watchdog.close();
});
