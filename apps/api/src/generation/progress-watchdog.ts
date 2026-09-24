import type { ProbeEvent } from '../runtime/types.js';
import { PROVIDER_RETRY_POLICY } from '../runtime/budgets.js';

/** Only Pi's static auto_retry_start notice can renew liveness. The event is
 * bounded by the configured consecutive attempt count and delay; model text or
 * a generic failed tool cannot masquerade as a retry. */
export function boundedProviderRetry(event: Pick<ProbeEvent, 'type' | 'success' | 'message' | 'requestNumber'>) {
  if (event.type !== 'model.stream.started' || event.success !== false
    || !Number.isSafeInteger(event.requestNumber) || (event.requestNumber ?? 0) < 1) return null;
  const match = /^(?:检查者请求|协调者请求|模型第 \d+ 轮)第 (\d+)\/(\d+) 次瞬态失败，(\d+)ms 后重试$/.exec(event.message);
  if (!match) return null;
  const attempt = Number(match[1]), maxAttempts = Number(match[2]), delayMs = Number(match[3]);
  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > maxAttempts
    || maxAttempts !== PROVIDER_RETRY_POLICY.maxRetries
    || !Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > PROVIDER_RETRY_POLICY.maxAgentDelayMs) return null;
  return { requestNumber: event.requestNumber!, attempt, maxAttempts, delayMs };
}

const meaningfullyCompletedTools = new Set([
  'submit_plan', 'request_clarification',
  'write', 'edit', 'bash',
  'browser_click', 'browser_fill', 'browser_select', 'browser_press', 'browser_key_batch', 'browser_form', 'browser_steps',
  'record_behavior', 'submit_review',
]);

/** Each distinct provider request gets one credit for its first actual stream delta. */
export function createMeaningfulProgressGate() {
  const streamedRequests = new Set<string>();
  const providerRetries = new Set<string>();
  return (roleRunId: string, event: Pick<ProbeEvent, 'type' | 'toolName' | 'success' | 'message' | 'requestNumber'>): boolean => {
    if (event.type === 'model.stream.started') {
      const retry = boundedProviderRetry(event);
      if (retry) {
        const key = `${roleRunId}:${retry.requestNumber}:${retry.attempt}`;
        if (providerRetries.has(key)) return false;
        providerRetries.add(key);
        return true;
      }
      if (event.success !== true || !Number.isSafeInteger(event.requestNumber) || (event.requestNumber ?? 0) < 1) return false;
      const request = `${roleRunId}:${event.requestNumber}`;
      if (streamedRequests.has(request)) return false;
      streamedRequests.add(request);
      return true;
    }
    return event.type === 'tool.end' && event.success === true
      && meaningfullyCompletedTools.has(event.toolName ?? '');
  };
}

/** Aborts a Run only when its persisted inactivity lease stops advancing. */
export function createRunProgressWatchdog(initialDeadlineAt: string, controller: AbortController) {
  let expiresAt = Date.parse(initialDeadlineAt);
  if (!Number.isFinite(expiresAt)) throw new Error('Invalid Run progress deadline');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', close);
  };
  const arm = () => {
    clearTimeout(timer);
    if (closed || controller.signal.aborted) return;
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) { controller.abort('RUN_TIMEOUT'); return; }
    timer = setTimeout(() => {
      if (Date.now() >= expiresAt) controller.abort('RUN_TIMEOUT');
      else arm();
    }, Math.min(remaining, 2_147_483_647));
    timer.unref?.();
  };
  controller.signal.addEventListener('abort', close, { once: true });
  arm();
  return {
    touch(deadlineAt: string) {
      const next = Date.parse(deadlineAt);
      if (!Number.isFinite(next)) throw new Error('Invalid Run progress deadline');
      if (next > expiresAt) { expiresAt = next; arm(); }
    },
    close,
  };
}
