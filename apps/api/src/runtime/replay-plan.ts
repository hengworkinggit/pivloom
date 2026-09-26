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
 * check. Missing steps, missing assertions and a render-only judgement each send
 * the behaviour back to the model-driven path instead of being approximated
 * here; that rate is the observed cost of unexecutable planning and must stay
 * visible rather than silently lowering coverage.
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
    const outcome = await runReplayProgram({ browser: input.browser, program, signal: input.signal,
      target: { expected: target.expected }, rendersOnly: allowsRenderOnlyEvidence(target),
      saveScreenshot: input.saveScreenshot });
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
  | { kind: 'fallback'; compiled: string[]; uncompilable: ReplayUncompilable[] };

/** Compiles, runs and assembles the whole A layer, or reports why the model path must still run. */
export async function runScriptedPlan(input: RunScriptedPlanInput): Promise<ScriptedPlanOutcome> {
  const handoff = HandoffSchema.parse(input.handoff);
  if (handoff.toRole !== 'reviewer' || handoff.runId !== input.binding.runId || handoff.attempt !== input.binding.attempt
    || handoff.expectedRevisionId !== input.binding.revisionId || handoff.sourceHash !== input.binding.sourceHash
    || input.browser.sessionId !== input.binding.browserSessionId)
    throw new RuntimeError('INVALID_HANDOFF', '检查交接与当前候选不匹配');
  const compiled = compilePlan(handoff.plan);
  const total = handoff.plan.behaviors.length;
  // A behaviour whose result depends on appearance is uncompilable by contract, so on a realistic plan
  // the uncompilable list is never empty and the whole plan used to fall back to the model-driven path
  // — the very half hour this work exists to remove. When every uncompilable reason is appearance and a
  // judge is supplied, those behaviours are driven and judged instead, and an all-visual plan must not
  // be turned away here before that can happen.
  const judgeVisual = Boolean(input.visualJudge) && compiled.uncompilable.length > 0
    && compiled.uncompilable.every((entry) => entry.reason === 'visual-evidence');
  if (compiled.programs.length === 0 && !judgeVisual)
    return { kind: 'fallback', compiled: [], uncompilable: compiled.uncompilable };
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
  if (compiled.uncompilable.length > 0 && !judgeVisual) {
    // The model path reports on the whole plan, so a partially compiled plan must
    // not submit a partial result: the caller falls back entirely. The progress
    // events already emitted stay valid because the browser work really happened.
    return { kind: 'fallback', compiled: compiled.programs.map((program) => program.behaviorId), uncompilable: compiled.uncompilable };
  }
  // The appearance behaviours were driven and captured rather than compiled into the scripted pass,
  // so their items come from the judge. A kernel `blocked` item is never upgraded: it records that the
  // behaviour produced no real action and no render-only evidence, and no model verdict can supply that.
  const captures = judgeVisual
    ? await captureVisualPrograms({ behaviors: handoff.plan.behaviors, browser: input.browser,
        signal: input.signal, saveScreenshot: input.saveScreenshot })
    : undefined;
  const verdicts = captures && input.visualJudge
    ? await judgeVisualBehaviours({
        behaviours: [...captures.values()].map((capture) => ({
          id: capture.behaviorId,
          expected: handoff.plan.behaviors.find((behavior) => behavior.id === capture.behaviorId)?.expected ?? '',
          images: capture.images,
        })),
        request: input.visualJudge.request,
        deadlineMs: REVIEW_WALL_CLOCK_BUDGET_MS,
        now: input.visualJudge.now ?? (() => performance.now()),
      })
    : undefined;
  const items = handoff.plan.behaviors.map((behavior) => {
    const item = run.items.get(behavior.id);
    if (item) {
      if (item.expected !== behavior.expected)
        throw new RuntimeError('REPLAY_PROGRAM_MISSING', '脚本回放没有覆盖全部计划行为');
      return item;
    }
    const capture = captures?.get(behavior.id);
    if (!capture || capture.item.expected !== behavior.expected)
      throw new RuntimeError('REPLAY_PROGRAM_MISSING', '脚本回放没有覆盖全部计划行为');
    const verdict = verdicts?.get(behavior.id);
    if (!verdict || capture.item.verdict === 'blocked') return capture.item;
    return { ...capture.item, verdict: verdict.verdict, actual: verdict.reason.slice(0, 2000) };
  });
  const result: ReviewResult = ReviewResultSchema.parse({ revisionId: input.binding.revisionId, sourceHash: input.binding.sourceHash,
    items, summary: summarize(items) });
  const visualEvidence = captures ? [...captures.values()].flatMap((capture) => capture.evidence) : [];
  const visualArtifacts = captures ? [...captures.values()].flatMap((capture) => capture.artifacts) : [];
  const assembled = markReviewerResultVerified({ result,
    evidence: [...run.evidence, ...visualEvidence], artifacts: [...run.artifacts, ...visualArtifacts],
    usage: zeroUsage(), chromeClosed: true } as ReviewerResult);
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
  return `脚本回放 ${items.length} 项行为：${passed} 项通过，${failed} 项未通过，模型未参与浏览器驱动。`;
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
    // stays uncompilable for a reason other than appearance and the caller keeps the whole-plan
    // fallback for it. Skipping here is deliberate, not a silent drop.
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
