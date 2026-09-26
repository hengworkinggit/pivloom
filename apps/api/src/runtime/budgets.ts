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
 * A review costs roughly this many tool calls per planned behaviour, and a repair pass repeats
 * the work. A fixed limit therefore leaves larger plans unfinished: a forty-five behaviour plan
 * used about 240 calls on its first pass and the repair pass then exceeded 280 without ever
 * submitting a report. Scale with the plan instead, and cap it so no plan is unbounded.
 */
export const REVIEW_TOOL_CALLS_PER_BEHAVIOR = 8;
export const REVIEW_TOOL_LIMIT_CEILING = 600;
/** One implementation and the two repairs finishReview permits; Builder itself caps each pass at 80. */
export const GENERATION_ATTEMPT_LIMIT = 3;
export const BUILDER_TOOL_LIMIT = 80;
export const COORDINATOR_TOOL_LIMIT = 12;
export const RUN_TOOL_LIMIT_CEILING = COORDINATOR_TOOL_LIMIT + GENERATION_ATTEMPT_LIMIT * (BUILDER_TOOL_LIMIT + REVIEW_TOOL_LIMIT_CEILING);
export function reviewToolLimitForPlan(behaviors: number): number {
  return Math.max(REVIEW_TOOL_LIMIT, Math.min(behaviors * REVIEW_TOOL_CALLS_PER_BEHAVIOR, REVIEW_TOOL_LIMIT_CEILING));
}
export function generationToolLimitForPlan(behaviors: number): number {
  return Math.min(RUN_TOOL_LIMIT_CEILING, Math.max(RUN_TOOL_LIMIT,
    COORDINATOR_TOOL_LIMIT + GENERATION_ATTEMPT_LIMIT * (BUILDER_TOOL_LIMIT + reviewToolLimitForPlan(behaviors))));
}
/**
 * Serialized ceiling for one check's observation record. Each observation keeps up
 * to 12000 characters of accessibility tree and 12000 of page text, both of which
 * `observation_read` must be able to hand back after Pi compaction, so the record
 * grows with the number of observations a check needs. At 480 KB that was roughly
 * twenty observations: enough for the 28- and 38-behaviour checks, not for the
 * 44-behaviour one, which aborted as REVIEW_EVIDENCE_TOO_LARGE. The real fix is to
 * shrink the per-observation payload; until then this is raised to fit a large
 * behaviour set, and it remains a genuine limit rather than a removed guard.
 */
export const REVIEW_EVIDENCE_LIMIT_BYTES = 2 * 1024 * 1024;

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

/**
 * Hard wall-clock ceiling for the verification phase of one increment, which is
 * the product's ten-minute acceptance floor. This is a total ceiling, not an
 * inactivity lease: a check that keeps producing real progress still stops. It is
 * enforced per layer: `runReviewer` enforces the model-judged share on a monotonic
 * clock today, and the replay layer enforces its own share when it lands.
 *
 * The phase is split between the deterministic, model-free replay layer and the
 * model-judged layer, so the two shares below always sum to this ceiling by
 * construction, and a test pins that arithmetic.
 */
export const VERIFICATION_WALL_CLOCK_LIMIT_MS = 600_000;
/** Inside the same deadline: leave time to bind evidence, close Chrome and persist the Check. */
export const REVIEW_FINALIZATION_RESERVE_MS = 30_000;

/**
 * Share of the verification ceiling reserved for the deterministic replay layer,
 * which drives the browser from compiled plan steps without a model. Its measured
 * target is one to two minutes, so two minutes are reserved here. The model-judged
 * layer receives only the remainder, which keeps the sum inside the product
 * ceiling even when the replay layer runs to the end of its own reserve.
 */
export const REPLAY_WALL_CLOCK_BUDGET_MS = 120_000;

/**
 * Share of the verification ceiling owned by the model-judged layer (today the
 * only production path, `runReviewer`): the total ceiling minus the replay
 * reserve, eight minutes. `runReviewer` starts its monotonic clock when it begins,
 * so its own elapsed time is bounded by exactly this value, and the two shares
 * add back to `VERIFICATION_WALL_CLOCK_LIMIT_MS` by construction.
 */
export const REVIEW_WALL_CLOCK_BUDGET_MS = VERIFICATION_WALL_CLOCK_LIMIT_MS - REPLAY_WALL_CLOCK_BUDGET_MS;

/**
 * Fast-fail reserve inside `REVIEW_WALL_CLOCK_BUDGET_MS`: once less than this
 * remains, the Reviewer admits no further browser evidence and answers evidence
 * tool calls with an instruction to submit what it already has.
 *
 * It is derived from the measured Reviewer pace. The file header records an
 * attempt that made about twenty model turns in a little over 720 s, so one turn
 * averages roughly 36 s. One honest evidence cycle for a behaviour is three turns
 * — act, screenshot, record — so about 108 s, and the forced submission still
 * needs its own submit turn plus the browser log read inside it. Two minutes
 * covers both; any collection started with less than that cannot finish inside
 * the ceiling. A stop is always a failure: if the forced submission never
 * produces an acceptable report the check ends as REVIEW_TIMEOUT or
 * AGENT_OUTPUT_INVALID, never as a pass.
 */
export const REVIEW_SUBMISSION_RESERVE_MS = 120_000;

/**
 * Ceiling for the number of observations one check may persist. The cap has to
 * hold every observation a whole plan produces, not one behaviour: a
 * forty-five behaviour plan with a few interactions each overran the previous
 * limit of 256, and because the rejection surfaced as a bare ZodError the run
 * died at save time as a generic GENERATION_FAILED with no check stored.
 *
 * The value is defined here rather than in data/generation.ts so the capacity
 * model (runtime/capacity.ts) can compare the entry count against the byte bound
 * and the tool budget without importing the persistence layer; generation.ts
 * re-exports it under its original name and applies it to the evidence schema.
 */
export const REVIEW_EVIDENCE_ENTRY_LIMIT = 4096;
