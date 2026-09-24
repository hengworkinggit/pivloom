import type { ProbeEvent } from '../runtime/types.js';

const meaningfullyCompletedTools = new Set([
  'submit_plan', 'request_clarification',
  'write', 'edit', 'bash',
  'browser_click', 'browser_fill', 'browser_select', 'browser_press', 'browser_key_batch', 'browser_form',
  'record_behavior', 'submit_review',
]);

/** A role gets one first-stream credit; later liveness needs an actual action. */
export function createMeaningfulProgressGate() {
  const firstStreamSeen = new Set<string>();
  return (roleRunId: string, event: Pick<ProbeEvent, 'type' | 'toolName' | 'success' | 'message'>): boolean => {
    if (event.type === 'model.stream.started') {
      if (event.success !== true || firstStreamSeen.has(roleRunId)) return false;
      firstStreamSeen.add(roleRunId);
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
