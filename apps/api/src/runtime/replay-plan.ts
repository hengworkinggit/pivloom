import { createHash, randomUUID } from 'node:crypto';
import { HandoffSchema, ReviewResultSchema, allowsRenderOnlyEvidence,
  type BehaviorStep, type BehaviorTarget, type Handoff, type ReviewBinding, type ReviewItem, type ReviewResult } from '@pivloom/contracts';
import { REVIEW_EVIDENCE_LIMIT_BYTES } from './budgets.js';
import { RuntimeError, type ProbeEventSink } from './types.js';
import { assertReviewerResult, markReviewerResultVerified, type ReviewCheckpoint, type ReviewerResult, type ReviewObservationEvent } from './reviewer.js';
import { judgeVisualBehaviours } from './visual-judgement.js';
import { REVIEW_WALL_CLOCK_BUDGET_MS } from './budgets.js';
import { runReplayProgram, type ReplayBrowser, type ReplayProgram, type ReplayStep } from './replay.js';
import type { StoredArtifact } from '../storage/artifacts.js';

/**
 * The A layer: turn the executable fields of a sealed plan into programs the
 * model-free kernel can run, execute them in one pass over one bound browser, and
 * assemble exactly the `ReviewerResult` the model-driven Reviewer returns. The
 * shape is reused rather than duplicated because both consumers downstream
 * (`assertReviewerResult` and `finishReview`) validate it identically; a second
 * shape here would be a second, weaker accept path.
 */

/** Why a behaviour could not be handed to the deterministic layer. */
export type ReplayFallbackReason = 'missing-steps' | 'missing-assertions' | 'visual-evidence';
export interface ReplayUncompilable {
  behaviorId: string;
  reason: ReplayFallbackReason;
}
export interface CompiledPlan {
  programs: ReplayProgram[];
  uncompilable: ReplayUncompilable[];
}
/**
 * A behaviour is compilable only when the plan says how to drive it and what to
 * check. Missing steps, missing assertions and a render-only judgement cannot be
 * approximated here, so each is reported in `uncompilable` with its reason and
 * settled per behaviour by the caller — appearance behaviours by the pixel judge,
 * the rest as `blocked`. That rate is the observed cost of unexecutable planning
 * and must stay visible rather than silently lowering coverage; it is no longer a
 * reason to redo the whole check on the model path.
 */
export function compilePlan(plan: Handoff['plan']): CompiledPlan {
  const programs: ReplayProgram[] = [];
  const uncompilable: ReplayUncompilable[] = [];
  for (const behavior of plan.behaviors) {
    if (!behavior.steps?.length) {
      uncompilable.push({ behaviorId: behavior.id, reason: 'missing-steps' });
      continue;
    }
    if (!behavior.assertions?.length) {
      // Steps without a stated expectation are a recorded walkthrough, not a
      // check. Passing them would accept a candidate on the strength of having
      // clicked something, which no layer in this service permits.
      uncompilable.push({ behaviorId: behavior.id, reason: 'missing-assertions' });
      continue;
    }
    if (declaresVisualEvidence(behavior)) {
      // The script executes nothing here: this layer cannot read the render and
      // is forbidden from inventing appearance evidence, so a visual behaviour
      // goes to the layer that can see pixels.
      uncompilable.push({ behaviorId: behavior.id, reason: 'visual-evidence' });
      continue;
    }
    programs.push({ behaviorId: behavior.id, steps: behavior.steps.map(toReplayStep), assertions: behavior.assertions });
  }
  return { programs, uncompilable };
}
/** The plan's own statement that the verdict depends on pixels, not only text and controls. */
export function declaresVisualEvidence(behavior: Pick<BehaviorTarget, 'evidence'>): boolean {
  return behavior.evidence === 'visual';
}
/** Re-emits a plan step as the kernel's step, dropping fields the union does not carry. */
export function toReplayStep(step: BehaviorStep): ReplayStep {
  switch (step.type) {
    case 'open': return { type: 'open', path: step.path };
    case 'reload': return { type: 'reload' };
    case 'resize': return { type: 'resize', width: step.width, height: step.height };
    case 'click': return { type: 'click', role: step.role, name: step.name };
    case 'fill': return { type: 'fill', role: step.role, name: step.name, text: step.text };
    case 'select': return { type: 'select', role: step.role, name: step.name, value: step.value };
    case 'press': return { type: 'press', key: step.key };
    case 'wait': return { type: 'wait', ms: step.ms };
    case 'capture': return { type: 'capture' };
  }
}

export interface ReplayRunProgramsInput {
  browser: ReplayBrowser;
  /** The sealed behaviours: the expectation and the render-only predicate are read from here, never restated by a model. */
  behaviors: ReadonlyArray<Pick<BehaviorTarget, 'id' | 'expected' | 'action'>>;
  signal: AbortSignal;
  saveScreenshot(image: { base64: string; mimeType: 'image/png'; sha256: string }): Promise<StoredArtifact>;
  /**
   * Renews the owning Run's inactivity lease after each program. The A layer makes
   * no provider request, so it produces no `model.stream.started` event and the
   * lease would otherwise expire mid-check; this is the one progress signal
   * available to it, and the caller binds it to the active reviewer role run.
   */
  onProgress?(program: ReplayProgram, result: { assertionsPassed: boolean }): Promise<void>;
}
export interface ReplayProgramsResult {
  items: Map<string, ReviewItem>;
  evidence: ReviewObservationEvent[];
  artifacts: StoredArtifact[];
}
/**
 * Executes every compiled program against the one bound browser, in plan order,
 * and returns the items, evidence and artifacts they produced. A failed
 * assertion is returned, not thrown: it is a fact about the candidate, whereas
 * only a browser protocol error (stale ref, incomplete observation, blocked
 * transport) is an error about this layer and ends the run.
 */
export async function runPrograms(compiled: CompiledPlan, input: ReplayRunProgramsInput): Promise<ReplayProgramsResult> {
  const items = new Map<string, ReviewItem>();
  const evidence: ReviewObservationEvent[] = [];
  const artifacts: StoredArtifact[] = [];
  const expected = new Map(input.behaviors.map((behavior) => [behavior.id, behavior]));
  for (const program of compiled.programs) {
    input.signal.throwIfAborted();
    const target = expected.get(program.behaviorId);
    if (!target) throw new RuntimeError('REPLAY_PROGRAM_MISSING', '脚本程序缺少对应的封存行为');
    let outcome;
    try {
      outcome = await runReplayProgram({ browser: input.browser, program, signal: input.signal,
        target: { expected: target.expected }, rendersOnly: allowsRenderOnlyEvidence(target),
        saveScreenshot: input.saveScreenshot });
    } catch (error) {
      input.signal.throwIfAborted();
      // One broken program must not cost the whole increment. A measured run lost all forty behaviours
      // because the second one threw: the replay aborted, every behaviour was recorded blocked, and the
      // other thirty-five that had nothing wrong with them were never attempted - the opposite of
      // rerunning only the affected path. The behaviour is blocked and the rest carry on. A cancellation
      // or the evidence ceiling still aborts, because continuing would either ignore a stop or exceed a
      // limit the caller enforces anyway.
      // A classified failure is contained too, which is what the comparable products do: Momentic
      // quarantines what it cannot resolve and caps recovery per run, Octomind holds a fix for human
      // approval instead of stalling, QA Wolf gives the item its own Investigating state. None of them
      // discards the behaviours that already ran because one control could not be addressed - and a
      // measured replay had completed twenty-nine of thirty-nine when the thirtieth step named a button
      // that matched nothing, which threw away the whole check. Only a cancellation or the evidence
      // ceiling still aborts, because continuing would either ignore a stop or exceed a limit the caller
      // enforces anyway.
      if ((error as { classification?: unknown } | null)?.classification === 'REVIEW_EVIDENCE_TOO_LARGE') throw error;
      // The code travels with the reason so the verdict says why, in a form a caller can act on, rather
      // than only that something went wrong - the observability rule the comparable products follow.
      const detail = error instanceof RuntimeError ? `${error.code}: ${error.message}`
        : error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      items.set(program.behaviorId, { behaviorId: program.behaviorId, verdict: 'blocked' as const,
        expected: target.expected,
        actual: `脚本回放该行为时失败，未取得可判定证据：${detail.slice(0, 300)}`,
        observationEventIds: [], screenshotIds: [], reproSteps: [] });
      await input.onProgress?.(program, { assertionsPassed: false });
      continue;
    }
    // The evidence ceiling is the Reviewer's own constant: this layer produces
    // more, smaller observations than the model loop, and it must fail with the
    // same code and the same REVIEW_EVIDENCE_TOO_LARGE classification instead of
    // discovering a new limit later in `finishReview`.
    if (Buffer.byteLength(JSON.stringify([...evidence, ...outcome.events])) > REVIEW_EVIDENCE_LIMIT_BYTES)
      throw new RuntimeError('CHECK_BLOCKED', '检查记录达到大小上限', undefined, undefined, 'REVIEW_EVIDENCE_TOO_LARGE');
    evidence.push(...outcome.events);
    artifacts.push(...outcome.screenshots);
    items.set(program.behaviorId, outcome.item);
    await input.onProgress?.(program, { assertionsPassed: outcome.assertionsPassed });
  }
  return { items, evidence, artifacts };
}

/**
 * The model call the visual layer needs, injected so this module never holds a provider client: the
 * judge receives prompts and pixels and hands back text, and nothing here can reach the browser.
 */
export interface VisualJudgePort {
  request(prompt: string, images: Array<{ base64: string; mimeType: string }>): Promise<string>;
  now?: () => number;
}
export interface RunScriptedPlanInput extends Omit<ReplayRunProgramsInput, 'onProgress' | 'behaviors'> {
  visualJudge?: VisualJudgePort;
  binding: ReviewBinding;
  handoff: Handoff;
  onEvent?: ProbeEventSink;
  onCheckpoint?(checkpoint: ReviewCheckpoint): Promise<void>;
}
export type ScriptedPlanOutcome =
  | { kind: 'scripted'; result: ReviewerResult }
  // A fallback carries no compiled ids by construction: it is only returned when this layer has no
  // deterministic or pixel-judged verdict to keep, so the model path is not discarding any real result.
  | { kind: 'fallback'; uncompilable: ReplayUncompilable[] };

/** Compiles, runs and assembles the whole A layer, or reports why the model path must still run. */
export async function runScriptedPlan(input: RunScriptedPlanInput): Promise<ScriptedPlanOutcome> {
  const handoff = HandoffSchema.parse(input.handoff);
  if (handoff.toRole !== 'reviewer' || handoff.runId !== input.binding.runId || handoff.attempt !== input.binding.attempt
    || handoff.expectedRevisionId !== input.binding.revisionId || handoff.sourceHash !== input.binding.sourceHash
    || input.browser.sessionId !== input.binding.browserSessionId)
    throw new RuntimeError('INVALID_HANDOFF', '检查交接与当前候选不匹配');
  const compiled = compilePlan(handoff.plan);
  const total = handoff.plan.behaviors.length;
  // The judgement spends what is left of the model-judged share, not a fresh copy of it: the scripted
  // pass above has already consumed part of the increment's budget, and granting the judge the full
  // share again would let the two together run past the ten minute ceiling they are meant to respect.
  const clock = input.visualJudge?.now ?? (() => performance.now());
  const startedAt = clock();
  // An uncompilable behaviour is settled on its own; it never discards the pass. A behaviour whose
  // verdict lives in the pixels is captured and judged by the appearance layer when a judge is
  // available, and one whose plan states no steps or no assertions is recorded `blocked` with its
  // reason — the fail-closed answer, which is never a pass. The measured run this replaces had 35
  // compiled behaviours thrown away because 4 could not compile, sending the whole check back down
  // the model path's half hour; Stagehand, Momentic and Skyvern each redo only the affected step.
  const visualIds = new Set(compiled.uncompilable.filter((entry) => entry.reason === 'visual-evidence')
    .map((entry) => entry.behaviorId));
  const judgeVisual = Boolean(input.visualJudge) && visualIds.size > 0;
  if (compiled.programs.length === 0 && !judgeVisual) {
    // Nothing deterministic is available at all: no program to run and no behaviour the appearance
    // layer may judge. Only this state — not a partially compilable plan — sends the check back to the
    // model path, and it is reached before any browser work, so the model path starts from the page
    // this layer never touched.
    return { kind: 'fallback', uncompilable: compiled.uncompilable };
  }
  await input.onEvent?.({ id: randomUUID(), at: new Date().toISOString(), type: 'tool.start', toolName: 'browser_steps',
    toolCallId: replayCallId(input.binding.roleRunId, 'start'),
    message: `脚本回放开始：${compiled.programs.length}/${total} 项行为可编译，行为判定不调用模型` });
  const run = await runPrograms(compiled, { browser: input.browser, signal: input.signal, behaviors: handoff.plan.behaviors,
    saveScreenshot: input.saveScreenshot,
    async onProgress(program, progress) {
      // One trusted tool.completed per compiled program. It renews the rolling
      // inactivity lease without any provider request, and `browser_steps` is the
      // allowlisted tool whose work this actually is: the same ordered browser
      // steps that tool performs. Emitting after the program finished, not
      // before, is what keeps the event honest.
      await input.onEvent?.({ id: randomUUID(), at: new Date().toISOString(), type: 'tool.end', toolName: 'browser_steps',
        toolCallId: replayCallId(input.binding.roleRunId, program.behaviorId), success: true,
        message: progress.assertionsPassed ? `脚本回放完成 ${program.behaviorId}`
          : `脚本回放完成 ${program.behaviorId}（断言未通过，已记录实际结果）` });
    } });
  // Checkpoints are emitted after the pass, not inside it: the reviewer's
  // checkpoint carries the behaviours completed so far, which is only known once
  // the items map exists, and a provisional note must never delay the renewal
  // event that keeps the run alive.
  await emitCheckpoints(input, run, compiled, total);
  // Only the behaviours this layer is allowed to judge are captured: a visual behaviour that is
  // uncompilable for a different reason (no steps, no assertions) is a blocked item below, not a
  // capture problem, and driving it here would spend browser work on a behaviour no judge may pass.
  let judgeCalls = 0;
  const captures = judgeVisual
    ? await captureVisualPrograms({ behaviors: handoff.plan.behaviors.filter((behavior) => visualIds.has(behavior.id)),
        browser: input.browser, signal: input.signal, saveScreenshot: input.saveScreenshot })
    : undefined;
  const verdicts = captures && input.visualJudge
    ? await judgeVisualBehaviours({
        behaviours: [...captures.values()].map((capture) => ({
          id: capture.behaviorId,
          expected: handoff.plan.behaviors.find((behavior) => behavior.id === capture.behaviorId)?.expected ?? '',
          images: capture.images,
        })),
        async request(prompt, images) { judgeCalls++; return input.visualJudge!.request(prompt, images); },
        deadlineMs: Math.max(0, REVIEW_WALL_CLOCK_BUDGET_MS - (clock() - startedAt)),
        now: clock,
      })
    : undefined;
  const uncompilableReasons = new Map(compiled.uncompilable
    .filter((entry) => !visualIds.has(entry.behaviorId))
    .map((entry) => [entry.behaviorId, entry.reason]));
  const items = handoff.plan.behaviors.map((behavior) => {
    const item = run.items.get(behavior.id);
    if (item) {
      if (item.expected !== behavior.expected)
        throw new RuntimeError('REPLAY_PROGRAM_MISSING', '脚本回放没有覆盖全部计划行为');
      return item;
    }
    const capture = captures?.get(behavior.id);
    if (capture) {
      if (capture.item.expected !== behavior.expected)
        throw new RuntimeError('REPLAY_PROGRAM_MISSING', '脚本回放没有覆盖全部计划行为');
      const verdict = verdicts?.get(behavior.id);
      // Only a behaviour the scripted pass already passed may be re-judged. Guarding `blocked` alone let a
      // model verdict overwrite a script `failed` into `passed`, which is fail-open in exactly the
      // direction that matters: the scripted assertion had already found the candidate wrong.
      if (!verdict || capture.item.verdict !== 'passed') return capture.item;
      return { ...capture.item, verdict: verdict.verdict, actual: verdict.reason.slice(0, 2000) };
    }
    // No program and no capture: the plan itself says this behaviour cannot be checked
    // deterministically. It is recorded with the reason rather than approximated, and
    // `blocked` is not a pass — `finishReview` still refuses to accept the revision.
    const reason = uncompilableReasons.get(behavior.id);
    if (reason) return { behaviorId: behavior.id, verdict: 'blocked' as const, expected: behavior.expected,
      actual: blockedItemText(reason), observationEventIds: [], screenshotIds: [], reproSteps: [] };
    throw new RuntimeError('REPLAY_PROGRAM_MISSING', '脚本回放没有覆盖全部计划行为');
  });
  const result: ReviewResult = ReviewResultSchema.parse({ revisionId: input.binding.revisionId, sourceHash: input.binding.sourceHash,
    items, summary: summarize(items) });
  const visualEvidence = captures ? [...captures.values()].flatMap((capture) => capture.evidence) : [];
  const visualArtifacts = captures ? [...captures.values()].flatMap((capture) => capture.artifacts) : [];
  const assembled = markReviewerResultVerified({ result,
    evidence: [...run.evidence, ...visualEvidence], artifacts: [...run.artifacts, ...visualArtifacts],
    usage: { ...zeroUsage(), modelCalls: judgeCalls }, chromeClosed: true } as ReviewerResult);
  // The same assertion the model-driven path must pass. Marking this result is
  // what lets the existing receipt path accept it unchanged; it does not relax
  // the assertion for any other producer, and every item here was produced by a
  // real browser step recorded in `evidence`.
  assertReviewerResult(assembled);
  return { kind: 'scripted', result: assembled };
}

/** Stable per-behaviour call id so a retried run is recognisable as the same work, not new progress. */
function replayCallId(roleRunId: string, key: string): string {
  return `replay-${createHash('sha256').update(`${roleRunId}:${key}`).digest('hex').slice(0, 24)}`;
}
/**
 * Provisional checkpoint per compiled behaviour, in the same shape the model
 * loop emits. They are audit notes only: the durable receipt still comes from
 * the assembled result, so a checkpoint never accepts a revision on its own.
 */
async function emitCheckpoints(input: RunScriptedPlanInput, run: ReplayProgramsResult,
  compiled: CompiledPlan, total: number): Promise<void> {
  if (!input.onCheckpoint) return;
  for (const program of compiled.programs) {
    const item = run.items.get(program.behaviorId);
    if (!item) throw new RuntimeError('REPLAY_PROGRAM_MISSING', '脚本程序没有产生对应的检查项');
    await input.onCheckpoint({ provisional: true, binding: input.binding, item,
      completedBehaviorIds: [...run.items.keys()], totalBehaviors: total,
      evidence: run.evidence.filter((event) => event.behaviorId === program.behaviorId),
      artifacts: run.artifacts.filter((artifact) => item.screenshotIds.includes(artifact.id)) });
  }
}
function summarize(items: ReviewItem[]): string {
  const passed = items.filter((item) => item.verdict === 'passed').length;
  const failed = items.filter((item) => item.verdict === 'failed').length;
  const blocked = items.filter((item) => item.verdict === 'blocked').length;
  // The blocked count is named because a partially compilable plan now submits its real verdicts with
  // the unverifiable behaviours marked blocked; a summary that reported only pass/fail would read as a
  // complete check when `finishReview` is about to record the run as blocked.
  return `脚本回放 ${items.length} 项行为：${passed} 项通过，${failed} 项未通过，${blocked} 项未取得确定性判定。`;
}
/**
 * Why a behaviour the plan could not compile is recorded `blocked`. The reason token travels with the
 * sentence so the verdict says which planning gap produced it, in a form a caller can act on. This is
 * where fail-closed is held: neither sentence is a pass, and `finishReview` still refuses the revision.
 */
function blockedItemText(reason: ReplayFallbackReason): string {
  return reason === 'missing-steps'
    ? '计划未提供可执行步骤，该行为无法在确定性层复现，未取得可判定证据（missing-steps）；当前候选尚未通过检查。'
    : reason === 'missing-assertions'
      ? '计划未提供可判定的断言，仅有操作步骤不构成检查，未取得可判定证据（missing-assertions）；当前候选尚未通过检查。'
      : '计划将该行为的判定交给外观证据，但本次检查没有可用的视觉判定，未取得可判定证据（visual-evidence）；当前候选尚未通过检查。';
}
/**
 * The A layer makes no provider request, so its usage is a factual zero rather
 * than an unavailable measurement. Reporting `unreported` with null tokens is the
 * honest shape for "this layer spends no tokens"; a non-zero toolCalls count
 * would charge the shared run ledger for work that used no model.
 */
function zeroUsage(): ReviewerResult['usage'] {
  return { input: null, output: null, total: null, cachedTokens: null, modelCalls: 0, toolCalls: 0,
    elapsedMs: 0, source: 'unreported' };
}
export interface VisualCapture {
  behaviorId: string;
  images: Array<{ base64: string; mimeType: string }>;
  artifactIds: string[];
  item: ReviewItem;
  /**
   * The persisted observation events behind this behaviour's item are returned rather than
   * recomputed: a merged item's `observationEventIds` must resolve in the very evidence that is
   * persisted, and only the run that produced them can hand them over. Rebuilding them later
   * would mint ids no store ever saw and `finishReview` would reject the check.
   */
  evidence: ReviewObservationEvent[];
  /** The stored artifact records, so the caller can merge the screenshot ids the item cites. */
  artifacts: StoredArtifact[];
}

/**
 * Captures the screenshots a visual behaviour has to be judged from.
 *
 * `compilePlan` classifies a behaviour whose result depends on appearance as uncompilable, and the
 * replay tests pin that contract — which means those behaviours' steps were never driven and no
 * screenshot exists for them yet. A judge handed an empty image list could only answer from the
 * expectation text, so this drives exactly those behaviours through the same kernel the scripted pass
 * uses. It calls no model: the pixels are collected here and the judgement happens afterwards, which
 * is what keeps a model from ever operating the browser.
 *
 * The captured bytes are kept in memory on the way past: the stored artifact carries the key and the
 * hash, not the pixels, and the judge needs the pixels.
 *
 * The save seam is widened with the observation and the behaviour the image belongs to, because
 * `StoredArtifact` carries neither and an image that cannot be tied back to the behaviour it was
 * taken for cannot be judged or merged. The kernel's capture marker calls `saveScreenshot` with the
 * image alone, so the observation id is remembered from the newest observation the browser produced
 * — the same value the kernel holds as the page state when it reaches the marker — instead of being
 * guessed afterwards, when the artifact would already be attributed to the wrong observation.
 */
export async function captureVisualPrograms(input: {
  behaviors: BehaviorTarget[];
  browser: ReplayBrowser;
  signal: AbortSignal;
  saveScreenshot(image: { base64: string; mimeType: 'image/png'; sha256: string;
    observationId: string; behaviorId: string }): Promise<StoredArtifact>;
}): Promise<Map<string, VisualCapture>> {
  const captures = new Map<string, VisualCapture>();
  let latestObservationId = '';
  const remember = <T extends { id: string }>(observation: T) => {
    latestObservationId = observation.id;
    return observation;
  };
  // Explicit delegation, never a spread: the production browser is a class instance whose methods
  // live on the prototype, and a spread would hand the kernel an object with none of them.
  const browser: ReplayBrowser = {
    sessionId: input.browser.sessionId,
    open: async (path) => remember(await input.browser.open(path)),
    observe: async () => remember(await input.browser.observe()),
    resize: async (width, height) => remember(await input.browser.resize(width, height)),
    act: async (action) => remember(await input.browser.act(action)),
    logs: () => input.browser.logs(),
    screenshot: () => input.browser.screenshot(),
  };
  for (const behavior of input.behaviors) {
    // A visual behaviour without steps is not a capture problem: nothing says what to drive, so it
    // stays uncompilable for a reason other than appearance and the caller records it blocked with that
    // reason. Skipping here is deliberate, not a silent drop.
    if (behavior.evidence !== 'visual' || !behavior.steps || behavior.steps.length === 0) continue;
    input.signal.throwIfAborted();
    const images: Array<{ base64: string; mimeType: string }> = [];
    const run = await runReplayProgram({
      browser,
      program: { behaviorId: behavior.id, steps: behavior.steps.map(toReplayStep), assertions: behavior.assertions ?? [] },
      target: { expected: behavior.expected },
      rendersOnly: allowsRenderOnlyEvidence(behavior),
      signal: input.signal,
      async saveScreenshot(image) {
        const artifact = await input.saveScreenshot({ ...image, observationId: latestObservationId,
          behaviorId: behavior.id });
        images.push({ base64: image.base64, mimeType: image.mimeType });
        return artifact;
      },
    });
    captures.set(behavior.id, { behaviorId: behavior.id, images, artifactIds: run.screenshots.map((artifact) => artifact.id),
      item: run.item, evidence: run.events, artifacts: run.screenshots });
  }
  return captures;
}
