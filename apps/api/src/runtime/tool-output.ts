import { randomUUID } from "node:crypto";
import type { ProbeEvent, ProbeEventSink } from "./types.js";

const BATCH_BYTES = 8 * 1024;
const JSON_MESSAGE_BYTES = 12 * 1024;
// Reserve envelope space and lifecycle events within the 2 MiB run budget.
const LOG_BYTES = 2 * 1024 * 1024 - 128 * 1024;
const MAX_QUEUED_BATCHES = 8;

function streamingRedactor(secrets: readonly string[], emit: (value: string) => void, overflow: () => void) {
  const labels = ["bearer", "api_key", "api-key", "apikey", "access_token", "access-token", "token", "password"];
  const credential = /\b(?:Bearer\s+["']?|(?:api[_-]?key|access[_-]?token|token|password)["']?\s*[:=]\s*["']?)/i;
  let buffered = "", suppress = false;
  return {
    append(value: string) {
      buffered += value;
      if (buffered.length > 16 * 1024) { buffered = ""; overflow(); return; }
      while (buffered) {
        if (suppress) {
          const delimiter = buffered.search(/[\s"'<>]/);
          if (delimiter < 0) { buffered = ""; return; }
          buffered = buffered.slice(delimiter); suppress = false;
        }
        const marker = credential.exec(buffered);
        let index = marker?.index ?? -1, length = marker?.[0].length ?? 0;
        let isCredential = index >= 0;
        for (const secret of secrets) {
          const found = buffered.indexOf(secret);
          if (found >= 0 && (index < 0 || found < index)) { index = found; length = secret.length; isCredential = false; }
        }
        if (index >= 0) {
          emit(buffered.slice(0, index) + "[REDACTED]");
          buffered = buffered.slice(index + length); suppress = isCredential;
          continue;
        }
        // Retain only a possible credential prefix, never raw secret fragments
        // across a timer/size flush. The state is bounded by the credential size.
        let held = 0;
        for (const secret of secrets) {
          for (let count = Math.min(buffered.length, secret.length - 1); count > held; count--) {
            if (secret.startsWith(buffered.slice(-count))) { held = count; break; }
          }
        }
        const lower = buffered.toLowerCase();
        for (const label of labels) {
          for (let count = Math.min(lower.length, label.length); count > held; count--) {
            const start = lower.length - count;
            if ((start === 0 || !/[\w]/.test(lower[start - 1])) && label.startsWith(lower.slice(start))) { held = count; break; }
          }
        }
        const labelSpace = /\b(?:Bearer|api[_-]?key|access[_-]?token|token|password)["']?\s*$/i.exec(buffered);
        if (labelSpace) held = Math.max(held, labelSpace[0].length);
        if (/[\uD800-\uDBFF]$/.test(buffered)) held = Math.max(held, 1);
        const end = buffered.length - held;
        emit(buffered.slice(0, end)); buffered = buffered.slice(end);
        return;
      }
    },
    finish() { if (buffered) emit("[REDACTED]"); buffered = ""; suppress = false; },
  };
}

function prefixLength(text: string) {
  let low = 1, high = text.length, best = 0;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    let end = middle;
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--;
    const value = text.slice(0, end);
    if (Buffer.byteLength(value) <= BATCH_BYTES && Buffer.byteLength(JSON.stringify(value)) <= JSON_MESSAGE_BYTES) {
      best = end; low = middle + 1;
    } else high = middle - 1;
  }
  return best;
}

/** Per-run tool output; lifecycle callers await finish before tool completion. */
export function createToolOutput(sink: ProbeEventSink | undefined, signal: AbortSignal, sensitiveValues: readonly string[]) {
  const secrets = [...new Set(sensitiveValues.filter(Boolean))];
  let tool: { toolName: string; toolCallId: string } | undefined;
  let pending = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let tail = Promise.resolve(), running = false, disposed = false;
  let used = 0, dropped = false, exhausted = secrets.some((value) => value.length > 8192), exhaustionReported = false;
  const queue: ProbeEvent[] = [];
  let failure: unknown;
  const pump = () => {
    if (running || disposed) return;
    running = true;
    tail = (async () => {
      try {
        while (queue.length && !signal.aborted && !disposed) await sink?.(queue.shift()!);
      } catch (error) { failure = error; queue.length = 0; pending = ""; }
      finally { running = false; }
    })();
  };
  const enqueue = (message: string, truncated = false) => {
    if (!tool || disposed || signal.aborted || failure) return;
    const event: ProbeEvent = { ...tool, id: randomUUID(), at: new Date().toISOString(), type: "tool.output", message, ...(truncated ? { truncated: true } : {}) };
    const cost = Buffer.byteLength(JSON.stringify(event)) + 1024;
    if (used + cost > LOG_BYTES - (truncated ? 0 : 2048)) { exhausted = true; dropped = true; return; }
    if (queue.length >= MAX_QUEUED_BATCHES) { dropped = true; return; }
    used += cost;
    queue.push(event);
    pump();
  };
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    if (!pending || !tool || signal.aborted || disposed) { pending = ""; return; }
    enqueue(pending);
    pending = "";
  };
  const drain = async () => { do { await tail; } while (running); if (failure) throw failure; };
  const dispose = () => { disposed = true; clearTimeout(timer); pending = ""; queue.length = 0; tool = undefined; };
  signal.addEventListener("abort", dispose, { once: true });
  const accept = (value: string) => {
    if (!value || dropped || disposed || signal.aborted) return;
    pending += value;
    while (Buffer.byteLength(pending) >= BATCH_BYTES || Buffer.byteLength(JSON.stringify(pending)) > JSON_MESSAGE_BYTES) {
      const length = prefixLength(pending);
      enqueue(pending.slice(0, length));
      pending = pending.slice(length);
      if (dropped) { pending = ""; return; }
    }
    if (pending && !timer) timer = setTimeout(flush, 250);
  };
  const overflow = () => { dropped = true; pending = ""; };
  let redactor = streamingRedactor(secrets, accept, overflow);
  return {
    start(value: { toolName: string; toolCallId: string }) { tool = value; dropped = exhausted; redactor = streamingRedactor(secrets, accept, overflow); },
    append(value: string) {
      for (let offset = 0; offset < value.length;) {
        if (signal.aborted || disposed || dropped || failure) return;
        let end = Math.min(value.length, offset + 4096);
        if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1]) && /[\uDC00-\uDFFF]/.test(value[end])) end--;
        redactor.append(value.slice(offset, end)); offset = end;
      }
      if (pending && !timer) timer = setTimeout(flush, 250);
    },
    async finish() {
      redactor.finish();
      flush(); await drain();
      if (dropped && (!exhausted || !exhaustionReported)) {
        enqueue("工具输出已截断：达到本次运行的日志或待保存缓冲上限。", true);
        if (exhausted) exhaustionReported = true;
        await drain();
      }
      tool = undefined;
    },
    dispose() { dispose(); signal.removeEventListener("abort", dispose); },
  };
}
