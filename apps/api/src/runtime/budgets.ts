/**
 * Run-wide resource budgets.
 *
 * Every value here started as an uncalibrated estimate in TRD §12.4. The
 * current numbers come from real three-role runs against the configured Ark
 * provider: the Coordinator needs ~75 s, the Builder 118-345 s, and a single
 * Reviewer attempt has run past 720 s while making ~20 model turns and ~28 gated
 * browser actions. Single model requests ranged from 8 to 120 s because the
 * model always streams a reasoning block that `max_tokens` cannot suppress (the
 * provider rejects `thinking:{type:"disabled"}` for this model). The measurement
 * record lives in artifacts/dev-06-2026-09-22/.
 */

/** Wall-clock ceiling for one run, including every role and repair attempt. */
export const RUN_DEADLINE_MS = 1_800_000;

/**
 * Ceiling for a single provider request. It stays well below the run ceiling so
 * a dead request cannot consume the whole run, but it must sit above the slowest
 * legitimate request: a degraded provider window streamed only ~36 characters
 * per second and needed more than 120 s for one Builder turn, while the idle
 * watchdog (no bytes at all) already cuts genuinely dead streams at 60 s.
 */
export const MODEL_REQUEST_TIMEOUT_MS = 210_000;

/**
 * Ceiling for one Reviewer attempt. Measured: a five-behavior check needs ~20
 * model turns plus ~28 gated browser actions, which has exceeded 720 s on a slow
 * provider day. It stays below the run ceiling minus the measured
 * Coordinator+Builder time (~200-420 s), so the run ceiling still wins.
 */
export const REVIEW_ATTEMPT_TIMEOUT_MS = 1_200_000;

/**
 * Shared ledger for every role, correction and repair turn in one run. Measured
 * usage is ~9.6k tokens per Reviewer turn at ~10k context resend, so a long
 * check plus a repair round lands well inside this ceiling.
 */
export const RUN_TOKEN_LIMIT = 400_000;

/** Total tool calls per run, including failed and retried calls. */
export const RUN_TOOL_LIMIT = 80;

/**
 * Accepted runs per account in a rolling 24 hours. Only a run the service
 * actually accepted is counted; an idempotent replay of the same request never
 * charges the quota twice and a rejected request is never charged at all.
 */
export const DAILY_ACCEPTED_LIMIT = 20;

/**
 * Ceiling for one preview rebuild. It covers sandbox start, locked dependency
 * install and the trusted build, but never a model call; it stays well under
 * the run ceiling so a stuck restore cannot hold the project lock for long.
 */
export const RESTORE_TIMEOUT_MS = 300_000;

/**
 * Bounded transient-provider retry. The Pi SDK applies exponential backoff
 * (`baseDelayMs * 2 ** (attempt - 1)`, capped by `maxAgentDelayMs`) and only
 * retries errors it classifies as transient; quota, billing and auth failures
 * fail fast. Transport-level retries stay disabled so every attempt is reserved
 * and accounted on the shared run ledger.
 */
export const PROVIDER_RETRY_POLICY = {
  enabled: true,
  // The Pi SDK keeps this counter for the whole role session (it is not reset
  // per turn), so a multi-turn Builder or Reviewer consumes the budget across
  // the run. A degraded provider window drops a stream every few turns, which
  // exhausted 2 retries mid-role and failed an otherwise healthy run; the
  // backoff is capped at 8 s, so a larger count costs seconds, not minutes.
  maxRetries: 6,
  baseDelayMs: 1_000,
  maxAgentDelayMs: 8_000,
} as const;

/** Minutes used in user-facing text, derived so the copy cannot drift. */
export const RUN_DEADLINE_MINUTES = Math.round(RUN_DEADLINE_MS / 60_000);

/** Provider retry settings for the Pi SDK session, including the SDK's own transport budget. */
export function providerRetrySettings() {
  return {
    ...PROVIDER_RETRY_POLICY,
    provider: { timeoutMs: MODEL_REQUEST_TIMEOUT_MS, maxRetries: 0 },
  };
}
