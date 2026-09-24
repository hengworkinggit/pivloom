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
