import type { GenerationRepository, StoredRestore, StoredRevision, StoredRun } from "../data/generation.js";

/**
 * Single-process dispatcher for the durable admission queue.
 *
 * PostgreSQL is the source of truth: nano.claim_next_queued_run claims one
 * capacity slot, the run row and the project operation lock in a single
 * transaction. This module only decides when to look, hands the claimed run to
 * the existing executor, and resumes from the persisted queue after a restart.
 * A remote kill or terminal write that fails is retried by the executor, so the
 * sweep here is a safety net rather than a timer that owns run state.
 */
export function createGenerationScheduler(options: {
  repository: GenerationRepository;
  start: (run: StoredRun) => void;
  /**
   * Hands a preview restore that was waiting for capacity to the executor. Both
   * queues draw on the same ceiling, so one sweep serves whichever has a slot.
   */
  startRestore?: (restore: StoredRestore, revision: StoredRevision) => void;
  /**
   * Claims one rollback that was waiting for capacity and starts it. Returns
   * whether one was claimed, so the sweep can count it.
   */
  startRollback?: () => Promise<boolean>;
  /**
   * Puts one idle preview to sleep so a waiting task can use its slot. Called
   * only when something is actually waiting and no capacity is free, so a
   * preview is never reclaimed while the instance has room.
   */
  sleepIdlePreview?: () => Promise<boolean>;
  /** Safety-net interval; accepted tasks and settled runs wake the queue directly. */
  sweepMs?: number;
  /** Ceiling on claims per wake-up so one backlog cannot starve the event loop. */
  maxPerTick?: number;
  onError?: (error: unknown) => void;
}) {
  const sweepMs = options.sweepMs ?? 3_000;
  if (!Number.isInteger(sweepMs) || sweepMs < 1) throw new Error("Queue sweep interval must be positive");
  const maxPerTick = options.maxPerTick ?? 4;
  if (!Number.isInteger(maxPerTick) || maxPerTick < 1) throw new Error("Queue batch size must be positive");
  let closing = false;
  let running: Promise<number> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  function report(error: unknown) {
    if (options.onError) options.onError(error);
    else console.error(`queue dispatch is pending (${error instanceof Error ? error.name : "unknown"})`);
  }

  async function dispatchOnce(): Promise<number> {
    const claimed = await options.repository.claimNextQueuedRun();
    if (!claimed) return 0;
    try {
      const prepared = await options.repository.prepareDispatch(claimed.ownerId, claimed.id);
      if (prepared.outcome === "ready") options.start(prepared.run);
    } catch (error) {
      // A claimed task that cannot be prepared must not wedge its project. Park
      // it with the real reason and let the next task in line proceed.
      report(error);
      await options.repository.parkQueuedRun(claimed.ownerId, claimed.id, {
        code: "QUEUE_DISPATCH_FAILED",
        message: "任务已保留，但调度时无法冻结执行条件；请稍后重试或重新提交。",
      }).catch(() => undefined);
    }
    return 1;
  }

  /** Claims one restore for a free slot; a failure here must not stall runs. */
  async function dispatchRestoreOnce(): Promise<number> {
    if (!options.startRestore) return 0;
    const claimed = await options.repository.claimNextQueuedRestore();
    if (!claimed) return 0;
    options.startRestore(claimed.restore, claimed.revision);
    return 1;
  }

  /** Claims one waiting rollback for a free slot, under the same ceiling. */
  async function dispatchRollbackOnce(): Promise<number> {
    if (!options.startRollback) return 0;
    return (await options.startRollback()) ? 1 : 0;
  }

  function tick(): Promise<number> {
    if (running) return running;
    running = (async () => {
      // A claim whose handoff never finished holds a project lock and a capacity
      // slot. Parking those first is what lets the loop advance instead of
      // stopping at the stuck task on every sweep.
      await options.repository.recoverStrandedClaims().catch(report);
      // A waiting restore takes a slot from the same ledger, so it is tried once
      // per sweep: it either gets a slot or leaves capacity for a run.
      await dispatchRestoreOnce().catch(report);
      await dispatchRollbackOnce().catch(report);
      // Something is waiting and nothing could start: the ceiling is held by
      // previews whose lease has not lapsed. Putting one to sleep lets the queue
      // move instead of waiting for wall-clock expiry, but only when a task
      // really is waiting and no capacity was free — an idle instance never
      // loses a preview to this.
      if (options.sleepIdlePreview && !(await options.repository.hasCapacityFree().catch(() => true))) {
        if (await options.repository.hasQueuedWork().catch(() => false)) {
          await options.sleepIdlePreview().catch(report);
        }
      }
      let dispatched = 0;
      while (!closing && dispatched < maxPerTick) {
        let claimed = 0;
        try {
          claimed = await dispatchOnce();
        } catch (error) {
          // One failed claim must not end the sweep; the next candidate in line
          // is still dispatchable and the timer retries the failed one.
          report(error);
          break;
        }
        if (claimed === 0) break;
        dispatched += claimed;
      }
      return dispatched;
    })().finally(() => { running = undefined; });
    return running;
  }

  function wake() {
    if (closing) return;
    void tick().catch(report);
  }

  return {
    tick,
    wake,
    start() {
      if (timer) return;
      timer = setInterval(() => { if (!closing) void tick().catch(report); }, sweepMs);
      timer.unref();
      wake();
    },
    async close() {
      closing = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      await running?.catch(() => undefined);
    },
  };
}
export type GenerationScheduler = ReturnType<typeof createGenerationScheduler>;
