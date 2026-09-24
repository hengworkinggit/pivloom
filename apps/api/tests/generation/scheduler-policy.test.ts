import { expect, test, vi } from "vitest";
import { createGenerationScheduler } from "../../src/generation/scheduler.js";

/**
 * The reclaim policy is what keeps one idle preview from holding the ceiling
 * while a task waits, and equally what keeps a preview from being taken when
 * nobody is waiting. It is pure control flow over the repository, so it is
 * pinned here without a database.
 */
function harness(overrides: { queued: boolean; capacityFree: boolean }) {
  const calls = { reclaimed: 0 };
  const repository = {
    recoverStrandedClaims: vi.fn(async () => []),
    claimNextQueuedRun: vi.fn(async () => null),
    prepareDispatch: vi.fn(),
    parkQueuedRun: vi.fn(),
    claimNextQueuedRestore: vi.fn(async () => null),
    hasQueuedWork: vi.fn(async () => overrides.queued),
    hasCapacityFree: vi.fn(async () => overrides.capacityFree),
  };
  const scheduler = createGenerationScheduler({
    repository: repository as never,
    start: () => {},
    startRestore: () => {},
    startRollback: async () => false,
    sleepIdlePreview: async () => { calls.reclaimed += 1; return true; },
  });
  return { scheduler, repository, calls };
}

test("sleeps one idle preview when a task waits and no capacity is free", async () => {
  const { scheduler, repository, calls } = harness({ queued: true, capacityFree: false });
  await scheduler.tick();
  expect(repository.hasQueuedWork).toHaveBeenCalled();
  expect(calls.reclaimed).toBe(1);
  await scheduler.close();
});

test("never takes a preview while the instance has free capacity", async () => {
  const { scheduler, calls } = harness({ queued: true, capacityFree: true });
  await scheduler.tick();
  expect(calls.reclaimed).toBe(0);
  await scheduler.close();
});

test("never takes a preview when nothing is waiting", async () => {
  const { scheduler, repository, calls } = harness({ queued: false, capacityFree: false });
  await scheduler.tick();
  expect(repository.hasQueuedWork).toHaveBeenCalled();
  expect(calls.reclaimed).toBe(0);
  await scheduler.close();
});

test("a reclaim that fails does not stop the sweep from claiming runs", async () => {
  const repository = {
    recoverStrandedClaims: vi.fn(async () => []),
    claimNextQueuedRun: vi.fn(async () => null),
    prepareDispatch: vi.fn(),
    parkQueuedRun: vi.fn(),
    claimNextQueuedRestore: vi.fn(async () => null),
    hasQueuedWork: vi.fn(async () => true),
    hasCapacityFree: vi.fn(async () => false),
  };
  const reports: unknown[] = [];
  const scheduler = createGenerationScheduler({
    repository: repository as never,
    start: () => {},
    sleepIdlePreview: async () => { throw new Error("sandbox API unreachable"); },
    onError: (error) => { reports.push(error); },
  });
  await scheduler.tick();
  expect(reports).toHaveLength(1);
  expect(repository.recoverStrandedClaims).toHaveBeenCalled();
  await scheduler.close();
});
