import { VERIFICATION_ATTEMPT_TIMEOUT_MS } from './budgets.js';

export interface VerificationAttemptWindow {
  startedAt: number;
  deadlineAt: number;
  startedAtWall: number;
}

/**
 * Call once after the service legitimately routes a new Reviewer attempt. Pass the same returned
 * window through its compiler, replay, interactive fallback, finalization and persistence. Never
 * recreate it for a tool retry or a stalled request. It does not reset token/tool ledgers or the
 * persisted Run idle lease, and a deadline expiry cannot turn incomplete checks into acceptance.
 */
export function createVerificationAttemptWindow(options: {
  now?: () => number;
  wallNow?: () => number;
  timeoutMs?: number;
} = {}): Readonly<VerificationAttemptWindow> {
  const timeoutMs = options.timeoutMs ?? VERIFICATION_ATTEMPT_TIMEOUT_MS;
  // Node timers clamp larger values to 1 ms rather than enforcing the requested duration.
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647)
    throw new RangeError('Verification attempt timeout must be a positive supported timer duration');
  const startedAt = (options.now ?? (() => performance.now()))();
  const startedAtWall = (options.wallNow ?? Date.now)();
  if (!Number.isFinite(startedAt) || !Number.isFinite(startedAtWall))
    throw new RangeError('Verification attempt clocks must be finite');
  return Object.freeze({ startedAt, deadlineAt: startedAt + timeoutMs, startedAtWall });
}
