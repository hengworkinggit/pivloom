import { TerminalRunStates, type RunEvent } from "@pivloom/contracts";
import type { GenerationRepository } from "../data/generation.js";
import { ApiFailure } from "../routes/errors.js";

type Subscriber = (event: RunEvent) => void | Promise<void>;

/** Single-instance commit notifications. Persistence remains the source of truth. */
export function createRunEventHub() {
  const subscribers = new Map<string, Set<Subscriber>>();
  return {
    subscribe(ownerId: string, runId: string, subscriber: Subscriber) {
      const key = `${ownerId}:${runId}`;
      const listeners = subscribers.get(key) ?? new Set<Subscriber>();
      subscribers.set(key, listeners);
      listeners.add(subscriber);
      return () => {
        listeners.delete(subscriber);
        if (!listeners.size) subscribers.delete(key);
      };
    },
    publish(ownerId: string, event: RunEvent) {
      for (const subscriber of subscribers.get(`${ownerId}:${event.runId}`) ?? []) {
        try { void Promise.resolve(subscriber(event)).catch(() => {}); }
        catch { /* A subscriber does not participate in the committed transaction. */ }
      }
    },
  };
}
export type RunEventHub = ReturnType<typeof createRunEventHub>;

export interface RunEventLimits { maxBufferedEvents: number; maxBufferedBytes: number }
const defaultLimits: RunEventLimits = { maxBufferedEvents: 128, maxBufferedBytes: 256 * 1024 };

export async function openRunEventStream(
  repository: GenerationRepository,
  hub: RunEventHub,
  input: { ownerId: string; runId: string; after: string; signal: AbortSignal },
  limits: RunEventLimits = defaultLimits,
) {
  const { ownerId, runId, after } = input;
  if (!/^\d{1,18}$/.test(after)) throw new ApiFailure(422, "INVALID_INPUT", "事件游标无效。");
  if (!Number.isInteger(limits.maxBufferedEvents) || limits.maxBufferedEvents < 1 || !Number.isInteger(limits.maxBufferedBytes) || limits.maxBufferedBytes < 1) throw Error("Invalid event stream limits");
  const controller = new AbortController();
  const pending = new Map<string, { event: RunEvent; bytes: number }>();
  let pendingBytes = 0;
  let cursor = after;
  let wake: (() => void) | undefined;
  let unsubscribe = () => {};
  const close = (reason: unknown = "CLOSED") => {
    if (controller.signal.aborted) return;
    controller.abort(reason);
    unsubscribe();
    input.signal.removeEventListener("abort", abort);
    pending.clear(); pendingBytes = 0;
    wake?.(); wake = undefined;
  };
  const abort = () => close(input.signal.reason);
  input.signal.addEventListener("abort", abort, { once: true });
  // Subscription is installed before any history read, including owner validation.
  // It is keyed by owner and cannot disclose data before readEventHead authorizes it.
  unsubscribe = hub.subscribe(ownerId, runId, (event) => {
    if (controller.signal.aborted || BigInt(event.eventId) <= BigInt(cursor) || pending.has(event.eventId)) return;
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (pending.size >= limits.maxBufferedEvents || pendingBytes + bytes > limits.maxBufferedBytes) {
      close("SLOW_CONSUMER");
      return;
    }
    pending.set(event.eventId, { event, bytes }); pendingBytes += bytes;
    wake?.(); wake = undefined;
  });
  if (input.signal.aborted) abort();
  try {
    const head = await repository.readEventHead(ownerId, runId);
    if (BigInt(after) > BigInt(head.eventId)) throw new ApiFailure(422, "INVALID_INPUT", "事件游标超出这个任务的已保存记录，请重新读取任务。");
    if (controller.signal.aborted) throw new ApiFailure(503, "EVENT_STREAM_CLOSED", "事件连接已关闭，请重新连接。", true);
    return {
      signal: controller.signal,
      close,
      async *[Symbol.asyncIterator](): AsyncGenerator<RunEvent> {
        let target = head.eventId;
        let terminal = TerminalRunStates.has(head.state);
        try {
          while (!controller.signal.aborted) {
            while (BigInt(cursor) < BigInt(target) && !controller.signal.aborted) {
              const events = await repository.listEventsThrough(ownerId, runId, cursor, target);
              if (!events.length) throw new ApiFailure(503, "EVENT_REPLAY_UNAVAILABLE", "事件记录暂时不可用，请重新连接。", true);
              for (const event of events) {
                if (controller.signal.aborted) return;
                yield event;
                cursor = event.eventId;
                terminal ||= event.type === "run.finished";
              }
            }
            for (const [id, buffered] of pending) {
              if (BigInt(id) <= BigInt(cursor)) { pending.delete(id); pendingBytes -= buffered.bytes; }
            }
            if (terminal) return;
            // Notifications can arrive out of order across PG connections. Read
            // every durable row through the largest committed ID, never skip gaps.
            target = [...pending.keys()].reduce((maximum, id) => BigInt(id) > BigInt(maximum) ? id : maximum, cursor);
            if (BigInt(target) > BigInt(cursor)) continue;
            await new Promise<void>((resolve) => { wake = resolve; });
          }
        } finally { close(); }
      },
    };
  } catch (error) { close(); throw error; }
}
