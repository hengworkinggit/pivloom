/**
 * Capacity model for one verification run.
 *
 * Every failure this file exists to prevent had the same shape: a limit was an
 * independent constant, the work was a function of plan size, and nothing
 * compared the two before the run started. So none of the numbers below is an
 * estimate of how a review "should" be sized. Each one is either read from the
 * constant that is enforced today (budgets.ts, data/generation.ts, contracts) or
 * measured from a record written in this repository by a real run, and the
 * comment above it says which. `envelope()` turns them into the work for N
 * behaviours; `limits()` turns that into the limit the work implies;
 * `preflightCapacity()` compares the two before the first model call.
 *
 * Shadow mode: `CAPACITY_ENFORCEMENT` is "shadow". The pre-flight always
 * reports what it would do, never throws, and changes no limit anywhere:
 * budgets.ts, reviewer.ts and the persistence layer keep their current values.
 * Flipping that one constant to "enforce" (or passing `{ mode: "enforce" }`) is
 * the single change that makes the check enforcing.
 */
import { MAX_CHECK_ARTIFACTS } from "@pivloom/contracts";
import {
  REVIEW_EVIDENCE_ENTRY_LIMIT,
  REVIEW_EVIDENCE_LIMIT_BYTES,
  REVIEW_TOOL_CALLS_PER_BEHAVIOR,
  REVIEW_TOOL_LIMIT,
  REVIEW_TOOL_LIMIT_CEILING,
  RUN_TOOL_LIMIT,
} from "./budgets.js";
import { RuntimeError } from "./types.js";

/** "shadow" reports; "enforce" additionally refuses a plan that cannot fit. */
export type CapacityMode = "shadow" | "enforce";

/**
 * The one flag that decides whether the pre-flight changes anything. It is
 * "shadow" for this change on purpose: the model has to be compared against real
 * runs before it may reject one. No caller has to read this constant to be safe;
 * it is the default argument of `preflightCapacity`, so an un-wired call site
 * cannot accidentally enforce.
 */
export const CAPACITY_ENFORCEMENT: CapacityMode = "shadow";

// ---------------------------------------------------------------------------
// Per-behaviour cost model. Measurements first, assumptions second, and every
// assumption is named so calibration edits one line instead of a formula.
// ---------------------------------------------------------------------------

/**
 * MEASURED first-pass reviewer work per behaviour. budgets.ts:47-49 records the
 * production measurement this model is built on: a forty-five behaviour plan
 * spent "about 240 calls on its first pass". 240 / 45.
 */
export const MEASURED_TOOL_CALLS_PER_BEHAVIOR = 240 / 45;

/**
 * The headroom the code already uses, not an invented one. budgets.ts:51 sets
 * REVIEW_TOOL_CALLS_PER_BEHAVIOR = 8 as the per-behaviour allowance the
 * Reviewer's own budget is scaled with (reviewer.ts:233-235). 8 / (240/45) is
 * exactly 1.5, so the envelope with this headroom reproduces the constant the
 * code enforces today rather than inventing a second opinion.
 */
export const CAPACITY_HEADROOM = REVIEW_TOOL_CALLS_PER_BEHAVIOR / MEASURED_TOOL_CALLS_PER_BEHAVIOR;

/**
 * Fixed tool calls a check spends that belong to no single behaviour. The
 * production path bootstraps the page and its first image before the model
 * starts, charging both to the same budget (generation/review.ts:111 sets
 * bootstrap: true; reviewer.ts:800 adds 2), and the instruction reserves one
 * more call for submit_review (reviewer.ts:806). Measured against the test
 * anchor at tests/runtime/reviewer.test.ts:1230, where 21 behaviours cost
 * exactly 1 + 21 x 3 calls because no bootstrap was used: that single call is
 * the same fixed cost, so 3 is the bootstrap path and 1 the in-test one.
 */
export const FIXED_TOOL_CALLS_PER_CHECK = 3;

/**
 * Coordinator allowance: executor.ts:217 passes `Math.min(12, toolLimit)`, the
 * code's own figure for planning (coordinator.ts:105).
 */
export const COORDINATOR_TOOL_CALLS = 12;

/**
 * NOT MEASURED — the only input in this file without a repository measurement.
 * pi.ts:217 is the Builder's own default tool allowance (`?? 64`), and the
 * executor hands the Builder whatever is left of the run ledger rather than this
 * number (executor.ts:269). It is kept as a named constant precisely so the
 * run-ledger finding below can be re-costed in one place once a real Builder
 * tool-call measurement exists.
 */
export const BUILDER_TOOL_CALLS = 64;

/**
 * MEASURED evidence entries per behaviour. The previous 256-entry array cap
 * overflowed on a forty-two behaviour check (docs/specs/
 * review-capacity-and-tiered-verification-v1.md:25 records "42 behaviours >
 * 256 entries"), so the measured cost is strictly more than 257 / 42 = 6.12.
 * Rounded up to the next whole entry.
 */
export const MEASURED_EVIDENCE_ENTRIES_PER_BEHAVIOR = Math.ceil(257 / 42);

/**
 * MEASURED evidence bytes per behaviour. budgets.ts:57-60 records that the
 * previous 480 KiB observation record was "roughly twenty observations" ("at
 * 480 KB that was roughly twenty observations ... not for the 44-behaviour one,
 * which aborted"). 480 KiB / 20 = 24 KiB for one observation, and every
 * behaviour that is reported needs at least one real action observation
 * (reviewer.ts itemProblem; persisted re-check in data/generation.ts:984-998),
 * so one observation is the per-behaviour floor. This is the conservative upper
 * bound of that record, not its average: the same comment says 480 KiB was
 * still enough for the 28- and 38-behaviour checks (about 12.6 KiB per
 * behaviour there), so the model deliberately over-reserves.
 */
export const MEASURED_EVIDENCE_BYTES_PER_BEHAVIOR = (480 * 1024) / 20;

/**
 * One post-action screenshot per visual behaviour: browser_steps saves one
 * artifact per captured step (reviewer.ts:543-547), key_batch saves one
 * (reviewer.ts:579-583) and the persisted re-check requires a screenshot for
 * render evidence (data/generation.ts:996). Measured 1 artifact per behaviour
 * in tests/runtime/reviewer.test.ts:1229 (21 behaviours, 21 artifacts).
 */
export const ARTIFACTS_PER_BEHAVIOR = 1;

// ---------------------------------------------------------------------------
// Plan and handoff bytes. These are resources that grow with plan size too, and
// they fail at coordinator submit time rather than mid-review (contracts/
// planning.ts:147 and :237), which is why the pre-flight has to cover them.
//
// Every byte constant below was measured by serializing the repository's own
// contract fixtures through the real schemas:
//   prose behaviour  -> tests/generation/planning-contracts.test.ts:32-34
//   compiled sequence -> tests/generation/planning-contracts.test.ts:56-65
//     (9 steps: open, reload, resize, click, fill, select, press, wait, capture;
//      5 assertions: text, negated text, control, negated control, console-error)
// JSON is serialized with JSON.stringify of the PARSED value, because the plan
// caps are applied to the parsed plan and schema defaults (role: "button",
// negated: false, open path: "/") are part of what gets stored.
// ---------------------------------------------------------------------------

/** MEASURED JSON bytes of one prose-only compiled fixture behaviour. */
export const BEHAVIOR_PROSE_BYTES = 128;

/** MEASURED per-step bytes in the 9-step fixture sequence (326 bytes / 9). */
export const BEHAVIOR_STEP_BYTES = 37;

/** MEASURED per-assertion bytes in the 5-assertion fixture set (259 / 5). */
export const BEHAVIOR_ASSERTION_BYTES = 52;

/** MEASURED cost of the `steps`/`assertions` empty-array skeleton. */
export const BEHAVIOR_ARRAY_SKELETON_BYTES = 27;

/** MEASURED cost of the optional `evidence: "visual"` flag. */
export const BEHAVIOR_EVIDENCE_FLAG_BYTES = 20;

/**
 * MEASURED residual: JSON punctuation that only appears once both arrays are
 * present. It is a measurement of the fixture, not a fudge factor, and the
 * capacity test re-derives it from the schema before trusting it.
 */
export const BEHAVIOR_CROSS_FIELD_PUNCTUATION_BYTES = 19;

/** The compiled shape the repository's own contract fixture uses. */
export const ASSUMED_STEPS_PER_BEHAVIOR = 9;
export const ASSUMED_ASSERTIONS_PER_BEHAVIOR = 5;

/**
 * The assumed per-behaviour plan cost: prose plus the compiled sequence above.
 * Written as the sum of its measured parts so a change to any part moves the
 * whole, and pinned to a fresh measurement by the capacity test.
 */
export const BEHAVIOR_PLAN_BYTES = BEHAVIOR_PROSE_BYTES + BEHAVIOR_ARRAY_SKELETON_BYTES
  + ASSUMED_STEPS_PER_BEHAVIOR * BEHAVIOR_STEP_BYTES
  + ASSUMED_ASSERTIONS_PER_BEHAVIOR * BEHAVIOR_ASSERTION_BYTES
  + BEHAVIOR_EVIDENCE_FLAG_BYTES + BEHAVIOR_CROSS_FIELD_PUNCTUATION_BYTES;

/** MEASURED cost of one prose behaviour with every prose field at its schema cap. */
export const MAXIMAL_PROSE_BEHAVIOR_BYTES = 4943;

/** MEASURED plan skeleton: goal, changeSummary, assumptions, outOfScope, 5 groups, replacements. */
export const PLAN_SCAFFOLD_BYTES = 412;

/** MEASURED bytes each behaviour id adds to its group's behaviorIds array. */
export const PLAN_GROUP_REFERENCE_BYTES = 7;

/** MEASURED fixed handoff cost: task text, artifactIds and the nullable fields. */
export const REVIEWER_HANDOFF_FIXED_BYTES = 422;

/**
 * MEASURED worst case a repair handoff adds: five failed checks of 1000
 * characters each, which is what data/generation.ts:1448-1449 stores
 * (`slice(0, 5)`, `slice(0, 1000)`), plus their JSON punctuation.
 */
export const REPAIR_FAILED_CHECKS_BYTES = 15_053;

/** contracts/planning.ts:147 caps a grouped plan at 96 KiB. */
export const PLAN_BYTE_LIMIT = 96 * 1024;
/** contracts/planning.ts:237 caps the whole handoff at 160 KiB. */
export const HANDOFF_BYTE_LIMIT = 160 * 1024;
/**
 * contracts/planning.ts:93-94 allows at most eighty behaviours, and the persisted
 * report has the same ceiling (contracts/review.ts:47). The capacity test proves
 * this number against GroupedPlanSchema rather than trusting the comment.
 */
export const MAX_PLAN_BEHAVIORS = 80;

/**
 * MEASURED bytes the persistence payload adds around the evidence array. The
 * Reviewer measures `JSON.stringify(evidence)` against
 * REVIEW_EVIDENCE_LIMIT_BYTES (reviewer.ts:284) while persistence measures
 * `JSON.stringify({ evidence })` (data/generation.ts assertReviewEvidenceFitsPersistence), so the wrapper is the
 * one place the two can disagree by a handful of bytes. It is measured here
 * instead of assumed so the persistence bound can be the Reviewer's bound plus
 * exactly this cost, never less.
 */
export const EVIDENCE_PERSISTENCE_WRAPPER_BYTES =
  Buffer.byteLength(JSON.stringify({ evidence: [] })) - Buffer.byteLength(JSON.stringify([]));

/**
 * The bound the persistence layer must accept: everything the Reviewer admitted
 * in-run, plus the wrapper the persistence payload itself adds. Deriving it from
 * REVIEW_EVIDENCE_LIMIT_BYTES is the fix for the drift where the Reviewer
 * allowed 2 MiB and persistence allowed a 512 KiB literal, so a check the
 * Reviewer had already paid for was rejected at save time as EVENT_TOO_LARGE.
 * The direction is deliberate: the size ceiling exists to bound work BEFORE the
 * model starts, so persistence must accept what the Reviewer accepted, never the
 * other way round.
 */
export const REVIEW_EVIDENCE_PERSISTENCE_LIMIT_BYTES =
  REVIEW_EVIDENCE_LIMIT_BYTES + EVIDENCE_PERSISTENCE_WRAPPER_BYTES;

// ---------------------------------------------------------------------------
// Envelope and limits.
// ---------------------------------------------------------------------------

export interface CapacityEnvelope {
  behaviours: number;
  /** Reviewer tool calls for one pass. */
  reviewToolCalls: number;
  /** Coordinator + Builder + one Reviewer pass, all charged to the shared run ledger. */
  runToolCalls: number;
  evidenceEntries: number;
  evidenceBytes: number;
  artifacts: number;
  planBytes: number;
  handoffBytes: number;
  /** Builder/repair handoff, which additionally carries up to five failed checks. */
  repairHandoffBytes: number;
}

/**
 * The measured work for N behaviours, rounded up per resource. The fractional
 * form is kept by `required()` so the headroom reproduces the code's own
 * 8-calls-per-behaviour allowance exactly instead of accumulating rounding.
 */
function rawEnvelope(behaviours: number) {
  const reviewToolCalls = behaviours * MEASURED_TOOL_CALLS_PER_BEHAVIOR;
  const planBytes = PLAN_SCAFFOLD_BYTES + behaviours * (BEHAVIOR_PLAN_BYTES + PLAN_GROUP_REFERENCE_BYTES);
  const reviewerHandoffBytes = planBytes + REVIEWER_HANDOFF_FIXED_BYTES;
  const repairHandoffBytes = reviewerHandoffBytes + REPAIR_FAILED_CHECKS_BYTES;
  return {
    reviewToolCalls,
    runToolCalls: COORDINATOR_TOOL_CALLS + BUILDER_TOOL_CALLS + reviewToolCalls,
    evidenceEntries: behaviours * MEASURED_EVIDENCE_ENTRIES_PER_BEHAVIOR,
    evidenceBytes: behaviours * MEASURED_EVIDENCE_BYTES_PER_BEHAVIOR,
    artifacts: behaviours * ARTIFACTS_PER_BEHAVIOR,
    planBytes,
    // Both handoffs are checked against the same 160 KiB HandoffSchema cap, so
    // the resource is the worse of the two: a repair handoff additionally
    // carries up to five failed checks.
    handoffBytes: Math.max(reviewerHandoffBytes, repairHandoffBytes),
    repairHandoffBytes,
  };
}

/** The measured envelope for `behaviours` behaviours. */
export function envelope(behaviours: number): CapacityEnvelope {
  const raw = rawEnvelope(behaviours);
  return {
    behaviours,
    reviewToolCalls: Math.ceil(raw.reviewToolCalls),
    runToolCalls: Math.ceil(raw.runToolCalls),
    evidenceEntries: Math.ceil(raw.evidenceEntries),
    evidenceBytes: Math.ceil(raw.evidenceBytes),
    artifacts: Math.ceil(raw.artifacts),
    planBytes: Math.ceil(raw.planBytes),
    handoffBytes: Math.ceil(raw.handoffBytes),
    repairHandoffBytes: Math.ceil(raw.repairHandoffBytes),
  };
}

export type CapacityResource =
  | "planBehaviours" | "reviewToolCalls" | "runToolCalls" | "evidenceEntries"
  | "evidenceBytes" | "artifacts" | "planBytes" | "handoffBytes";

export type CapacityLimits = Record<CapacityResource, number>;

/** Resources a review pass can be split across; the rest are properties of the plan itself. */
export const BATCHABLE_RESOURCES: ReadonlySet<CapacityResource> = new Set<CapacityResource>(
  ["reviewToolCalls", "evidenceEntries", "evidenceBytes", "artifacts"],
);

/** Where each number the check compares against comes from. */
export const CAPACITY_LIMIT_SOURCES: Record<CapacityResource, string> = {
  planBehaviours: "contracts/src/planning.ts:94 (GroupedPlanSchema .max(80))",
  reviewToolCalls: "reviewer.ts:233-235 max(REVIEW_TOOL_LIMIT, min(N x REVIEW_TOOL_CALLS_PER_BEHAVIOR, REVIEW_TOOL_LIMIT_CEILING))",
  runToolCalls: "budgets.ts:43 RUN_TOOL_LIMIT, charged across every role by executor.ts:270-273",
  evidenceEntries: "data/generation.ts:285-300 (reviewEvidenceSchema .max(REVIEW_EVIDENCE_ENTRY_LIMIT))",
  evidenceBytes: "budgets.ts:63 REVIEW_EVIDENCE_LIMIT_BYTES, enforced in-run at reviewer.ts:284 and at persistence from the same source (data/generation.ts assertReviewEvidenceFitsPersistence)",
  artifacts: "contracts/src/review.ts:9 MAX_CHECK_ARTIFACTS",
  planBytes: "contracts/src/planning.ts:147 (96 KiB)",
  handoffBytes: "contracts/src/planning.ts:237 (160 KiB)",
};

/** The limits the code enforces today, exactly as the cited lines compute them. */
export function currentLimits(behaviours: number): CapacityLimits {
  return {
    planBehaviours: MAX_PLAN_BEHAVIORS,
    reviewToolCalls: Math.max(REVIEW_TOOL_LIMIT,
      Math.min(behaviours * REVIEW_TOOL_CALLS_PER_BEHAVIOR, REVIEW_TOOL_LIMIT_CEILING)),
    runToolCalls: RUN_TOOL_LIMIT,
    evidenceEntries: REVIEW_EVIDENCE_ENTRY_LIMIT,
    evidenceBytes: REVIEW_EVIDENCE_LIMIT_BYTES,
    artifacts: MAX_CHECK_ARTIFACTS,
    planBytes: PLAN_BYTE_LIMIT,
    handoffBytes: HANDOFF_BYTE_LIMIT,
  };
}

/**
 * The work N behaviours implies, with headroom, in the shape every limit in the
 * code already has: `max(hardFloor, envelope x headroom + overhead)`. The
 * Reviewer's term keeps the fixed overhead outside the headroom because it is
 * spent once, not per behaviour; the run ledger adds the Coordinator and Builder
 * allowances to that same term instead of multiplying them.
 */
export function required(behaviours: number): CapacityLimits {
  const raw = rawEnvelope(behaviours);
  const reviewToolCalls = Math.ceil(raw.reviewToolCalls * CAPACITY_HEADROOM) + FIXED_TOOL_CALLS_PER_CHECK;
  return {
    planBehaviours: behaviours,
    reviewToolCalls,
    runToolCalls: COORDINATOR_TOOL_CALLS + BUILDER_TOOL_CALLS + reviewToolCalls,
    evidenceEntries: Math.ceil(raw.evidenceEntries * CAPACITY_HEADROOM),
    evidenceBytes: Math.ceil(raw.evidenceBytes * CAPACITY_HEADROOM),
    artifacts: Math.ceil(raw.artifacts * CAPACITY_HEADROOM),
    planBytes: Math.ceil(raw.planBytes * CAPACITY_HEADROOM),
    handoffBytes: Math.ceil(raw.handoffBytes * CAPACITY_HEADROOM),
  };
}

/**
 * The limit this model would set for N behaviours: the required work, never
 * below the hard floor the product already promises. This is the function that
 * would replace the independent constants if the model were made enforcing; it
 * is exported so the size of that change is visible, and it is NOT wired to any
 * limit in this task.
 */
export function limits(behaviours: number): CapacityLimits {
  const work = required(behaviours), floors = currentLimits(behaviours);
  const raised = {} as CapacityLimits;
  for (const resource of Object.keys(work) as CapacityResource[])
    raised[resource] = Math.max(floors[resource], work[resource]);
  return raised;
}

/**
 * The per-behaviour plan-byte budget the 96 KiB cap implies for N behaviours.
 * The coordinator can be given this number so it does not emit a plan its own
 * contract refuses: at the schema caps a behaviour costs
 * MAXIMAL_PROSE_BEHAVIOR_BYTES and only nineteen fit, while the compiled shape
 * this model measures fits eighty. It is a plan-writing budget, not a limit.
 */
export function planByteBudgetPerBehavior(behaviours: number) {
  return Math.floor((PLAN_BYTE_LIMIT - PLAN_SCAFFOLD_BYTES) / behaviours) - PLAN_GROUP_REFERENCE_BYTES;
}

// ---------------------------------------------------------------------------
// Pre-flight.
// ---------------------------------------------------------------------------

/** A limit is "near" at ninety percent: close enough that the next plan size will cross it. */
const NEAR_LIMIT_RATIO = 0.9;

export interface CapacityFinding {
  resource: CapacityResource;
  required: number;
  limit: number;
  exceededBy: number;
  batchable: boolean;
  /** required / limit, so a caller can see how much room is left even when it fits. */
  ratio: number;
  near: boolean;
  source: string;
}

export type CapacityVerdict = "ok" | "batch" | "refuse";

export interface CapacityAssessment {
  mode: CapacityMode;
  /** True only for "refuse", and only when the mode is "enforce". */
  enforced: boolean;
  behaviours: number;
  verdict: CapacityVerdict;
  envelope: CapacityEnvelope;
  required: CapacityLimits;
  limits: CapacityLimits;
  /** Every resource whose required work exceeds today's limit, worst first. */
  findings: CapacityFinding[];
  /** Resources that only fit because they are not near their limit yet. */
  near: CapacityFinding[];
  /** Largest review pass that fits; the batch size the recommendation uses. */
  maxBehavioursPerBatch: number;
  /** Concrete batch sizes, largest first. Empty when no split is possible. */
  batches: number[];
  /** Plan-writing budget per behaviour implied by the 96 KiB plan cap. */
  planByteBudgetPerBehavior: number;
  /** Inputs that are the code's default rather than a measurement. */
  unmeasuredInputs: ReadonlyArray<string>;
  message: string;
}

export interface CapacityPreflightOptions {
  mode?: CapacityMode;
  /** Calibration hook: replace the limits under test without editing any constant. */
  limits?: Partial<CapacityLimits>;
}

function compare(behaviours: number, limitsUnderTest: CapacityLimits) {
  const work = required(behaviours), findings: CapacityFinding[] = [], near: CapacityFinding[] = [];
  for (const resource of Object.keys(limitsUnderTest) as CapacityResource[]) {
    const value = work[resource], limit = limitsUnderTest[resource];
    const ratio = limit > 0 ? value / limit : Number.POSITIVE_INFINITY;
    const finding: CapacityFinding = { resource, required: value, limit, exceededBy: Math.max(0, value - limit),
      batchable: BATCHABLE_RESOURCES.has(resource), ratio, near: ratio >= NEAR_LIMIT_RATIO, source: CAPACITY_LIMIT_SOURCES[resource] };
    if (value > limit) findings.push(finding);
    else if (finding.near) near.push(finding);
  }
  // Ratios are unitless, so they order a byte cap and a call cap comparably.
  findings.sort((left, right) => right.ratio - left.ratio);
  near.sort((left, right) => right.ratio - left.ratio);
  return { findings, near };
}

/**
 * Does one pass of `behaviours` fit inside every batchable limit? The Reviewer's
 * own limit scales with the batch (reviewer.ts:233-235), so a batch is checked
 * against the limit it would actually run under rather than the whole plan's.
 */
function oneBatchFits(behaviours: number, overrides: Partial<CapacityLimits>) {
  const work = required(behaviours), batchLimits = { ...currentLimits(behaviours), ...overrides };
  for (const resource of BATCHABLE_RESOURCES) if (work[resource] > batchLimits[resource]) return false;
  return true;
}

function largestBatch(overrides: Partial<CapacityLimits>) {
  let largest = 0;
  for (let size = 1; size <= MAX_PLAN_BEHAVIORS; size++) if (oneBatchFits(size, overrides)) largest = size;
  return largest;
}

function splitIntoBatches(behaviours: number, maxBehaviourPerBatch: number) {
  const batches: number[] = [];
  for (let remaining = behaviours; remaining > 0; remaining -= maxBehaviourPerBatch)
    batches.push(Math.min(remaining, maxBehaviourPerBatch));
  return batches;
}

const kib = (bytes: number) => `${(bytes / 1024).toFixed(1)} KiB`;

function describeNumbers(finding: CapacityFinding) {
  return finding.resource === "planBytes" || finding.resource === "handoffBytes" || finding.resource === "evidenceBytes"
    ? `需要 ${kib(finding.required)}，上限 ${kib(finding.limit)}`
    : `需要 ${finding.required}，上限 ${finding.limit}`;
}

function describe(finding: CapacityFinding) {
  return `${finding.resource} ${describeNumbers(finding)}（超出 ${finding.exceededBy}）`;
}

function describeNear(finding: CapacityFinding) {
  return `${finding.resource} 已用 ${(finding.ratio * 100).toFixed(1)}%（${describeNumbers(finding)}）`;
}

/**
 * Inputs this model uses that are the code's own default rather than a
 * measurement. The pre-flight prints them so a refusal can never look like it
 * rests on a measured number when one of its terms does not.
 */
export const UNMEASURED_CAPACITY_INPUTS: ReadonlyArray<string> = Object.freeze([
  `BUILDER_TOOL_CALLS=${BUILDER_TOOL_CALLS} (pi.ts:217 default allowance, not a measured Builder tool-call count)`,
]);

/**
 * The pre-flight. In shadow mode it always returns an assessment and never
 * throws, so it can be compared against real runs for a week before it is
 * believed. In enforce mode it additionally throws CAPACITY_REFUSED when the
 * verdict is "refuse"; "batch" is returned with concrete sizes for the caller
 * to execute, because only the caller can decide to spend model calls on a
 * second pass.
 */
export function preflightCapacity(behaviours: number, options: CapacityPreflightOptions = {}): CapacityAssessment {
  const mode = options.mode ?? CAPACITY_ENFORCEMENT;
  if (!Number.isInteger(behaviours) || behaviours < 1)
    throw new RuntimeError("CAPACITY_INVALID", "容量预检需要正整数条行为");
  const overrides = options.limits ?? {};
  const limitsUnderTest = { ...currentLimits(behaviours), ...overrides };
  const { findings, near } = compare(behaviours, limitsUnderTest);
  const maxBehavioursPerBatch = largestBatch(overrides);
  const batches = maxBehavioursPerBatch > 0 ? splitIntoBatches(behaviours, maxBehavioursPerBatch) : [];
  // A plan can be split unless a resource that is a property of the plan itself
  // (its own byte cap, its behaviour count) is over, or a single behaviour
  // already exceeds one review pass.
  const unbatchable = findings.filter((finding) => !finding.batchable);
  const verdict: CapacityVerdict = unbatchable.length > 0 || (findings.length > 0 && maxBehavioursPerBatch < 1)
    ? "refuse"
    : findings.length > 0 ? "batch" : "ok";
  const summary = verdict === "refuse"
    ? `容量预检拒绝：${findings.map(describe).join("；")}`
    : verdict === "batch"
      ? `容量预检建议分批：${findings.map(describe).join("；")}；按 ${maxBehavioursPerBatch} 条一批，批次 ${batches.join("+")}`
      : `容量预检通过：${behaviours} 条行为在现有上限内${near.length ? `；接近上限：${near.map(describeNear).join("；")}` : ""}`;
  const sharedLedger = unbatchable.some((finding) => finding.resource === "runToolCalls");
  const assumptions = sharedLedger ? `；未实测输入：${UNMEASURED_CAPACITY_INPUTS.join("，")}` : "";
  const message = `${summary}${sharedLedger ? "；运行级工具账本由整个 run 共用，分批只会增加总消耗，需拆分为独立 run 或调整 RUN_TOOL_LIMIT" : ""}${assumptions}`;
  if (mode === "enforce" && verdict === "refuse") throw new RuntimeError("CAPACITY_REFUSED", message);
  return { mode, enforced: false, behaviours, verdict,
    envelope: envelope(behaviours), required: required(behaviours), limits: limitsUnderTest,
    planByteBudgetPerBehavior: planByteBudgetPerBehavior(behaviours),
    findings, near, maxBehavioursPerBatch, batches, message, unmeasuredInputs: UNMEASURED_CAPACITY_INPUTS };
}
