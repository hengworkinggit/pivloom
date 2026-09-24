/**
 * Per-operation limits and rolling liveness leases.
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

/** Rolling deadline for lack of real Run progress, never a total Run duration. */
export const RUN_IDLE_TIMEOUT_MS = 360_000;

/** Renewable remote lease: short enough to expire after a crashed process. */
export const SANDBOX_LEASE_SEGMENT_MS = 420_000;
/** Renew before a full legitimate provider request can outlive the lease. */
export const SANDBOX_LEASE_RENEW_THRESHOLD_MS = 300_000;
/** One final temporary Preview window after a successful Check; never rolled. */
export const ACCEPTED_PREVIEW_LEASE_MS = 1_800_000;

/**
 * Ceiling for a single provider request. It stays below the inactivity lease so
 * a dead request cannot hold the project forever, but it must sit above the slowest
 * legitimate request: a degraded provider window streamed only ~36 characters
 * per second and needed more than 120 s for one Builder turn, while the idle
 * watchdog (no bytes at all) already cuts genuinely dead streams at 60 s.
 */
export const MODEL_REQUEST_TIMEOUT_MS = 210_000;

/**
 * Shared ledger for every role, correction and repair turn in one run. Measured
 * usage is ~9.6k tokens per Reviewer turn at ~10k context resend, so a long
 * check plus a repair round lands well inside this ceiling.
 */
/**
 * The Reviewer needs at least one action, image capture and recorded verdict per
 * grouped target. Keep room for Builder and Coordinator even at the 80-target
 * schema ceiling; the rolling inactivity lease and per-item cadence remain.
 */
export const RUN_TOOL_LIMIT = 384;
export const REVIEW_TOOL_LIMIT = 280;

/**
 * Accepted runs per account in a rolling 24 hours. Only a run the service
 * actually accepted is counted; an idempotent replay of the same request never
 * charges the quota twice and a rejected request is never charged at all.
 */
export const DAILY_ACCEPTED_LIMIT = 20;

/**
 * Ceiling for one preview rebuild. It covers sandbox start, locked dependency
 * install and the trusted build, but never a model call. Restore is a separate
 * bounded operation and cannot hold the project lock indefinitely.
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
  // Pi 0.86.1 resets its retry attempt after a successful assistant response.
  // This bounds one consecutive transient-error chain, not the whole role.
  // The backoff is capped at 8 seconds per retry.
  maxRetries: 6,
  baseDelayMs: 1_000,
  maxAgentDelayMs: 8_000,
} as const;

/** Provider retry settings for the Pi SDK session, including the SDK's own transport budget. */
export function providerRetrySettings() {
  return {
    ...PROVIDER_RETRY_POLICY,
    provider: { timeoutMs: MODEL_REQUEST_TIMEOUT_MS, maxRetries: 0 },
  };
}

/** Pi's native compaction adapts its retained context to smaller BYOK windows. */
export function piCompactionSettings(contextWindow: number) {
  const quarter = Math.max(1, Math.floor(contextWindow / 4));
  return {
    enabled: true,
    reserveTokens: Math.min(16_384, quarter),
    keepRecentTokens: Math.min(20_000, quarter),
  };
}
