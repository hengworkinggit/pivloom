import { createParser } from "eventsource-parser";
import { RunEventSchema, type RunEvent } from "@pivloom/contracts";

/** Decode a single authorized connection. Durable snapshots remain authoritative. */
export async function readRunEvents(response: Response, options: {
  runId: string; after?: string; signal: AbortSignal; onEvent(event: RunEvent): void;
}) {
  if (!response.headers.get("content-type")?.includes("text/event-stream") || !response.body) {
    throw new Error("事件连接返回了无法读取的响应。");
  }
  let cursor = options.after ?? "0";
  const parser = createParser({
    maxBufferSize: 64 * 1024,
    onError() { throw new Error("事件格式异常，正在重新读取任务状态。"); },
    onEvent(message) {
      if (options.signal.aborted) return;
      let event: RunEvent;
      try { event = RunEventSchema.parse(JSON.parse(message.data)); }
      catch { throw new Error("事件格式异常，正在重新读取任务状态。"); }
      if (event.runId !== options.runId || message.id !== event.eventId || (message.event && message.event !== event.type)) {
        throw new Error("事件与当前任务不一致，正在重新读取任务状态。");
      }
      if (BigInt(event.eventId) <= BigInt(cursor)) return;
      cursor = event.eventId;
      options.onEvent(event);
    },
  });
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  options.signal.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder();
  try {
    while (!options.signal.aborted) {
      const chunk = await reader.read();
      if (options.signal.aborted) break;
      if (chunk.done) { parser.feed(decoder.decode()); break; }
      parser.feed(decoder.decode(chunk.value, { stream: true }));
    }
  } finally {
    options.signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return cursor;
}

export function mergeRunEvents(existing: RunEvent[], incoming: RunEvent[], runId: string) {
  const events = new Map(existing.filter((event) => event.runId === runId).map((event) => [event.eventId, event]));
  for (const event of incoming) if (event.runId === runId) events.set(event.eventId, event);
  return [...events.values()].sort((a, b) => BigInt(a.eventId) < BigInt(b.eventId) ? -1 : 1).slice(-200);
}
