/**
 * Run-wide resource budgets.
 *
 * Every value here started as an uncalibrated estimate in TRD §12.4. The
 * current numbers come from real three-role runs against the configured Ark
 * provider, where the Coordinator, Builder and Reviewer together needed about
 * 560-700 seconds and single model requests ranged from 8 to 57 seconds because
 * the model always streams a reasoning block that `max_tokens` cannot suppress.
 * The measurement record lives in artifacts/dev-06-2026-09-22/.
 */

/** Wall-clock ceiling for one run, including every role and repair attempt. */
export const RUN_DEADLINE_MS = 1_200_000;

/**
 * Ceiling for a single provider request. It stays below the run ceiling so one
 * stalled request cannot consume the whole run, but it must sit above the
 * slowest observed legitimate request (57 s for a five-behavior plan).
 */
export const MODEL_REQUEST_TIMEOUT_MS = 120_000;

/**
 * Ceiling for one Reviewer attempt. Measured: a five-behavior check needs
 * ~15 model turns (~25 s each) plus ~30 gated browser actions, so a real attempt
 * has run past 480 s. The ceiling stays below the run budget that remains after
 * the Coordinator and Builder (~425 s measured), so the run ceiling still wins.
 */
export const REVIEW_ATTEMPT_TIMEOUT_MS = 720_000;

/** Shared ledger for every role, correction and repair turn in one run. */
export const RUN_TOKEN_LIMIT = 300_000;

/** Total tool calls per run, including failed and retried calls. */
export const RUN_TOOL_LIMIT = 80;

/**
 * Bounded transient-provider retry. The Pi SDK applies exponential backoff
 * (`baseDelayMs * 2 ** (attempt - 1)`, capped by `maxAgentDelayMs`) and only
 * retries errors it classifies as transient; quota, billing and auth failures
 * fail fast. Transport-level retries stay disabled so every attempt is reserved
 * and accounted on the shared run ledger.
 */
export const PROVIDER_RETRY_POLICY = {
  enabled: true,
  maxRetries: 2,
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
