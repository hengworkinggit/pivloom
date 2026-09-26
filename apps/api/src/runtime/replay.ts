import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { BehaviorProgramSchema, ReviewItemSchema, type BehaviorAssertion, type BehaviorStep, type BehaviorTarget, type BehaviorTargetLocator } from '@pivloom/contracts';
import { RuntimeError } from './types.js';
import type { ReviewObservationEvent } from './reviewer.js';
import type { BrowserAction, BrowserProgramResponse, BrowserProgramFrame, BrowserObservation, BrowserKeyBatch, BrowserKeyBatchResult } from './browser.js';
import type { StoredArtifact } from '../storage/artifacts.js';

/**
 * Model-free execution of a compiled plan behaviour against the ReviewBrowser
 * seam. This is the browser_steps kernel from the reviewer's own tool handler,
 * lifted out of the model-driven loop: the steps, their order and the role+name
 * resolution are identical, but nothing here can make a provider request, so a
 * compiled behaviour costs no model turn. It imports only types from the
 * reviewer, and that handler is deliberately left untouched: the two must stay
 * behaviourally equivalent, which the tests assert instead of a shared loop.
 */
/** The plan's sealed step vocabulary is the kernel's vocabulary; there is no runtime-only wrapper. */
export type ReplayStep = BehaviorStep;
export interface ReplayProgram {
  /** One compiled program per behaviour: the evidence record and the renewal cadence are both per behaviour. */
  behaviorId: string;
  steps: ReplayStep[];
  assertions: BehaviorAssertion[];
  initialState?: 'fresh' | 'continue';
}
export interface ReplayStepResult {
  index: number;
  type: ReplayStep['type'];
  observationId: string;
  /** The persisted observation-event id for this step, if the step produced one. */
  evidenceId: string | null;
  url: string;
  text: string;
  artifactId?: string;
}
export interface ReplayObservation {
  id: string;
  behaviorId: string;
  action: ReplayAction | null;
  observationId: string;
  url: string;
  tree: string;
  text: string;
  truncated: boolean;
  key?: string;
  batch?: Pick<BrowserKeyBatchResult, 'startedAt' | 'finishedAt' | 'steps'>;
}
export interface ReplayAssertionResult {
  index: number;
  kind: BehaviorAssertion['kind'];
  passed: boolean;
  detail: string;
}
export interface ReplayProgramResult {
  item: ReturnType<typeof ReviewItemSchema.parse>;
  observations: ReplayObservation[];
  stepResults: ReplayStepResult[];
  screenshots: StoredArtifact[];
  assertionResults: ReplayAssertionResult[];
  /** True only when every script-decidable assertion held. */
  assertionsPassed: boolean;
  /** The observation events this program must contribute to the check's evidence record. */
  events: ReviewObservationEvent[];
}
/** The persisted evidence vocabulary (data/generation.ts `reviewEvidenceSchema`); anything else fails the check at save time. */
export type ReplayAction = 'click' | 'fill' | 'select' | 'press' | 'scroll' | 'reload' | 'key_batch' | 'wait';
/**
 * Maps a plan step onto the persisted action vocabulary. Only a genuine
 * interaction survives: an open, a resize, a wait or a screenshot is an
 * observation of the page, never proof that the behaviour acted on it, and
 * recording the plan's step name verbatim would either fail the evidence schema
 * (which has no `open`, `resize` or `capture`) or misuse `wait` as action proof.
 */
export function replayAction(step: ReplayStep): ReplayAction | null {
  if (step.type === 'click' || step.type === 'fill' || step.type === 'select' || step.type === 'press') return step.type;
  if (step.type === 'reload') return 'reload';
  if (step.type === 'key_sequence') return 'key_batch';
  return null;
}
export interface ReplayRunInput {
  browser: ReplayBrowser;
  program: ReplayProgram;
  /** The candidate's sealed target, echoed into the item rather than restated by a model. */
  target: Pick<BehaviorTarget, 'expected'>;
  /**
   * True only for a sealed action that asks to inspect a static render. Then a
   * real observation plus a screenshot is the evidence `finishReview` accepts for
   * a non-interactive script; without it the same script must not claim a pass.
   */
  rendersOnly: boolean;
  signal: AbortSignal;
  /**
   * Asked only when a step's control resolves to zero or to several matches. Given the step and the
   * controls the page actually offered, it may name one of their refs; anything else is refused and the
   * step remains a stale ref. Nothing is cached and nothing is written back to the plan, so a resolution
   * belongs to this step in this run - which is how the tools studied here recover a miss, and why a wrong
   * guess in the plan no longer costs a whole behaviour.
   */
  resolveControl?: ResolveControl;
  saveScreenshot(image: { base64: string; mimeType: 'image/png'; sha256: string; observationId?: string }): Promise<StoredArtifact>;
}
/** One control the freshest observation actually carries; a ref is minted per observation. */
export interface ReplayControlCandidate {
  ref: string;
  role?: string;
  name?: string;
}
/**
 * The step whose predicted control did not resolve to exactly one of the page's own controls, together
 * with the inventory the page really carries at the moment of the action. The plan's role+name is a
 * prediction made before the page was ever seen; the observation is what the page says instead, and it is
 * the only thing that can settle which control the step meant.
 */
export interface ControlResolutionRequest {
  step: Extract<ReplayStep, { type: 'click' | 'fill' | 'select' }>;
  /** Zero-based index in the program, so a resolver can name the step it was asked about. */
  index: number;
  /** Every control in the freshest observation, in observation order. */
  candidates: ReplayControlCandidate[];
}
/**
 * The optional seam that re-resolves one step against the page it is about to act on, the way Playwright's
 * locators resolve at the call and Stagehand reasons only for the failing call. It answers with a ref and
 * nothing else; the kernel admits that ref only if the current observation carries it.
 */
export type ResolveControl = (input: ControlResolutionRequest) => Promise<string | undefined>;
/**
 * The subset of `ReviewBrowser` the kernel needs. It is structurally compatible
 * with `ReviewBrowser`, so the caller passes the real browser, while the kernel
 * cannot reach the fields a script has no plan vocabulary for (a key batch's
 * tick timing stays a model judgement and never becomes a replay step).
 */
export interface ReplayBrowser {
  readonly nativePrograms?: boolean;
  executeProgram?(input: { steps: unknown[]; initialState?: string; targets?: BehaviorTargetLocator[];
    startIndex?: number; observation?: BrowserObservation; resolvedRefs?: Record<number, string> }): Promise<BrowserProgramResponse>;
  readonly sessionId: string;
  open(path?: string): Promise<BrowserObservation>;
  /** Start a clean app context. Later opens/reloads in this program retain its state. */
  reset?(path?: string): Promise<BrowserObservation>;
  observe(): Promise<BrowserObservation>;
  resize(width: number, height: number): Promise<BrowserObservation>;
  act(action: BrowserAction): Promise<BrowserObservation>;
  logs(): Promise<Record<string, unknown>>;
  screenshot(): Promise<{ base64: string; mimeType: 'image/png'; sha256: string }>;
  inspect?(target: BehaviorTargetLocator): Promise<ReplayTargetObservation>;
  keyBatch?(input: BrowserKeyBatch): Promise<BrowserKeyBatchResult>;
}
export interface ReplayTargetObservation {
  observation: BrowserObservation;
  matches: Array<{ text: string; value: string | null }>;
}
const REF = /^e[0-9]{1,6}$/;
/** Same bound as the reviewer's observation record: one step must not persist an
 * unbounded accessibility snapshot into the check's evidence. */
const OBSERVATION_TEXT_LIMIT = 12_000;
const TRUNCATION_SUFFIX = '…[truncated]';

function truncate(text: string): { text: string; truncated: boolean; textLength: number } {
  // The length travels with the value: knowing only that an observation was cut says nothing about
  // whether the window is slightly too small or the page is pathological, and those need opposite
  // fixes. A recorded run could say no more than "the observation was incomplete".
  return text.length <= OBSERVATION_TEXT_LIMIT
    ? { text, truncated: false, textLength: text.length }
    : { text: `${text.slice(0, OBSERVATION_TEXT_LIMIT - TRUNCATION_SUFFIX.length)}${TRUNCATION_SUFFIX}`, truncated: true, textLength: text.length };
}

/**
 * A positive assertion is usually a short UI string, and the body text kept on
 * the observation record is a bounded window that a long page can push a visible
 * string past; searching only that window would report a present string as
 * missing, which is the one failure direction an acceptance check must never
 * invent. So a positive assertion searches the full text the browser returned.
 * A negative assertion searches the bounded record instead, because seeing the
 * string there proves it was present, while not seeing it inside a truncated
 * window proves nothing — a false "absent" verdict is worse than an honest
 * "cannot decide", and the caller re-checks truncation for exactly that case.
 */
export function evaluateAssertions(
  assertions: ReadonlyArray<BehaviorAssertion>,
  evidence: {
    /** The bounded text kept on the observation record; this is what `actual` describes. */
    text: string;
    refs: Readonly<Record<string, { role?: string; name?: string }>>;
    /** The full body text the browser returned. */
    observationText: string;
    logs: Record<string, unknown>;
    targetMatches?: ReadonlyMap<number, ReplayTargetObservation['matches']>;
  },
): ReplayAssertionResult[] {
  const consoleErrors = Array.isArray(evidence.logs.errors) ? evidence.logs.errors.length : 0;
  return assertions.map((assertion, index) => {
    if ('target' in assertion) {
      const matches = evidence.targetMatches?.get(index);
      if (!matches) throw new RuntimeError('INVALID_TEST_PROGRAM', '目标断言缺少浏览器作用域证据');
      const label = `${assertion.target.role}/${JSON.stringify(assertion.target.name ?? '*')}`;
      if (assertion.kind === 'target-count') {
        const equal = matches.length === assertion.count;
        return { index, kind: assertion.kind, passed: assertion.negated ? !equal : equal,
          detail: `目标 ${label} 数量 ${matches.length}，预期 ${assertion.negated ? '非 ' : ''}${assertion.count}` };
      }
      if (matches.length !== 1) throw new RuntimeError('TEST_TARGET_AMBIGUOUS', `目标 ${label} 匹配 ${matches.length} 个，无法唯一判断结果`);
      const match = matches[0];
      if (assertion.kind === 'target-value' && match.value === null)
        throw new RuntimeError('INVALID_TEST_PROGRAM', `目标 ${label} 不是可读取 value 的表单控件`);
      const actual = assertion.kind === 'target-value' ? match.value! : match.text.trim();
      const expected = assertion.kind === 'target-value' ? assertion.value : assertion.text.trim();
      const found = assertion.kind === 'target-text' && assertion.match === 'contains' ? actual.includes(expected) : actual === expected;
      return { index, kind: assertion.kind, passed: assertion.negated ? !found : found,
        detail: `目标 ${label} ${assertion.kind === 'target-value' ? '值' : '文本'} ${JSON.stringify(actual)}，预期 ${assertion.negated ? '非 ' : ''}${JSON.stringify(expected)}` };
    }
    if (assertion.kind === 'text') {
      const haystack = assertion.negated ? evidence.text : evidence.observationText;
      const found = haystack.includes(assertion.text);
      return { index, kind: assertion.kind, passed: assertion.negated ? !found : found,
        detail: `文本 ${JSON.stringify(assertion.text)} ${found ? '出现' : '未出现'}` };
    }
    if (assertion.kind === 'control') {
      const matches = Object.values(evidence.refs)
        .filter((target) => target.role === assertion.role && target.name === assertion.name).length;
      return { index, kind: assertion.kind, passed: assertion.negated ? matches === 0 : matches > 0,
        detail: `控件 ${assertion.role}/${JSON.stringify(assertion.name)} 匹配 ${matches} 个` };
    }
    return { index, kind: assertion.kind, passed: assertion.negated ? consoleErrors === 0 : consoleErrors > 0,
      detail: `控制台错误 ${consoleErrors} 条` };
  });
}

/**
 * A missing or ambiguous control is the same event the model-driven loop reports
 * as a stale ref, and it must keep the same code: `recoverableToolErrors` and
 * the run-level classification both key off it. The step index and match count
 * are included because "the page changed" is not actionable without knowing
 * which step failed and whether the control disappeared or duplicated.
 */
function resolveControl(
  refs: Readonly<Record<string, { role?: string; name?: string }>>,
  step: Extract<ReplayStep, { type: 'click' | 'fill' | 'select' }>,
  index: number,
): string {
  const matches = Object.entries(refs)
    .filter(([key, target]) => REF.test(key) && target.role === step.role && target.name === step.name)
    .map(([key]) => key);
  if (matches.length !== 1)
    throw new RuntimeError('STALE_BROWSER_REF',
      `第 ${index + 1} 步控件不唯一或已改变（role=${step.role} name=${JSON.stringify(step.name)} 匹配 ${matches.length} 个），请重新观察`);
  return matches[0];
}

/**
 * Resolves a step's control, falling back to the caller's resolver only when the page does not offer
 * exactly one match. The resolver may name a ref the observation actually carries; a ref that is absent or
 * malformed is refused and the original stale-ref error stands. A blind click is therefore impossible by
 * construction - whether the resolver is missing, wrong, or lying - and without a resolver this behaves
 * exactly as it did before.
 */
async function resolveControlWithFallback(
  input: ReplayRunInput,
  refs: Readonly<Record<string, { role?: string; name?: string }>>,
  step: Extract<ReplayStep, { type: 'click' | 'fill' | 'select' }>,
  index: number,
): Promise<string> {
  try {
    return resolveControl(refs, step, index);
  } catch (error) {
    if (!input.resolveControl) throw error;
    const candidates = Object.entries(refs)
      .filter(([key]) => REF.test(key))
      .map(([ref, target]) => ({ ref, role: target.role, name: target.name }));
    // A resolver that fails must not replace the diagnosis with its own error: the caller sees the same
    // stale ref it would have seen had no resolver been configured, which keeps a model outage from
    // looking like a page that changed.
    let chosen: string | undefined;
    try {
      chosen = await input.resolveControl({ step, index, candidates });
    } catch {
      // A cancellation during the resolver's own work is not a resolution failure: the run is stopping, so
      // the abort travels instead of being folded into a stale-ref verdict about the page.
      input.signal.throwIfAborted();
      throw error;
    }
    input.signal.throwIfAborted();
    if (typeof chosen === 'string' && Object.prototype.hasOwnProperty.call(refs, chosen) && REF.test(chosen))
      return chosen;
    throw error;
  }
}

/**
 * Runs one compiled program and returns the real observations, step results and
 * the item the deterministic layer may submit. There is no re-observation retry
 * and no verdict retry: a step that cannot be resolved is a stale ref, exactly
 * as in the reviewer, because only the caller — which owns the model fallback
 * and the run state — may decide whether to continue or give up.
 */
export async function runReplayProgram(input: ReplayRunInput): Promise<ReplayProgramResult> {
  const { browser, program, signal } = input;
  if (program.steps.length === 0) throw new RuntimeError('REPLAY_PROGRAM_EMPTY', '空程序无法回放');
  const modern = program.assertions.some(assertion => 'target' in assertion) || program.steps.some(step => step.type === 'key_sequence');
  const admitted = BehaviorProgramSchema.safeParse({ ...program,
    initialState: program.initialState ?? (modern ? undefined : 'continue') });
  if (!admitted.success)
    throw new RuntimeError('INVALID_TEST_PROGRAM', `测试程序不能执行：${admitted.error.issues[0]?.message ?? '缺少明确初态或有效步骤'}`);
  if (program.initialState === 'fresh' && !browser.reset)
    throw new RuntimeError('INVALID_TEST_PROGRAM', '当前浏览器不能创建独立场景，未执行检查');
  if (program.steps.some(step => step.type === 'key_sequence') && !browser.keyBatch)
    throw new RuntimeError('INVALID_TEST_PROGRAM', '当前浏览器不支持有界键盘序列，未执行检查');
  signal.throwIfAborted();
  if (browser.nativePrograms && browser.executeProgram) return runNativeReplayProgram(input);

  const observations: ReplayObservation[] = [];
  const stepResults: ReplayStepResult[] = [];
  const screenshots: StoredArtifact[] = [];
  let latest: BrowserObservation | undefined;
  let actionKey: string | undefined;

  for (const [index, step] of program.steps.entries()) {
    signal.throwIfAborted();
    // Recorded with the observation this step produces, not read from a later
    // iteration: a trailing `capture` or `resize` must not relabel the interaction
    // observation that preceded it, which the save path reads as action evidence.
    const action = replayAction(step);
    actionKey = step.type === 'press' ? step.key : undefined;
    if (step.type === 'capture') {
      // Capture is a marker, not an action: the surrounding steps decided the
      // state, and the newest observation is what the image belongs to.
      if (!latest) throw new RuntimeError('STALE_BROWSER_REF', `第 ${index + 1} 步截图前还没有可用的页面观察`);
      const image = await browser.screenshot();
      const artifact = await input.saveScreenshot({ ...image, observationId: latest.id });
      screenshots.push(artifact);
      stepResults.push({ index, type: step.type, observationId: latest.id, evidenceId: observations.at(-1)?.id ?? null,
        url: latest.url, text: latest.text, artifactId: artifact.id });
      continue;
    }
    if (step.type !== 'open' && !latest)
      throw new RuntimeError('STALE_BROWSER_REF', `第 ${index + 1} 步操作前还没有可用的页面观察`);
    // The invariant the whole kernel rests on: every non-open step acts on the
    // freshest observation, never on a ref captured earlier in the program.
    const freshest = () => {
      if (!latest) throw new RuntimeError('STALE_BROWSER_REF', `第 ${index + 1} 步操作前还没有可用的页面观察`);
      return latest;
    };
    let observation: BrowserObservation;
    if (step.type === 'open') observation = index === 0 && program.initialState === 'fresh'
      ? await browser.reset!(step.path ?? '/') : await browser.open(step.path ?? '/');
    else if (step.type === 'reload') {
      // A reload is bound to the page the check is actually on: reconstructing it
      // from the newest observation is what makes it a persistence check rather
      // than a fresh first open, which the reviewer treats as non-behavioural.
      const url = new URL(freshest().url);
      observation = await browser.open(url.pathname + url.search + url.hash);
    } else if (step.type === 'key_sequence') {
      const keys = Array.from({ length: step.repeat }, () => step.keys).flat();
      // The existing browser/evidence protocol accepts eight real key events per batch.
      for (let offset = 0; offset < keys.length; offset += 8) {
        signal.throwIfAborted();
        const chunk = keys.slice(offset, offset + 8);
        const batch = await browser.keyBatch!({ observationId: freshest().id,
          steps: chunk.map(key => ({ key, waitMs: 0 })) });
        signal.throwIfAborted();
        if (batch.steps.length !== chunk.length || batch.steps.some((value, index) => !value.success || value.key !== chunk[index]))
          throw new RuntimeError('BROWSER_ACTION_FAILED', '键盘序列未完整执行，不能判断该行为通过');
        latest = batch.observation;
        const tree = truncate(latest.tree), text = truncate(latest.text);
        const record: ReplayObservation = { id: randomUUID(), behaviorId: program.behaviorId, action: 'key_batch',
          observationId: latest.id, url: latest.url, tree: tree.text, text: text.text,
          truncated: latest.truncated || tree.truncated || text.truncated,
          batch: { startedAt: batch.startedAt, finishedAt: batch.finishedAt, steps: batch.steps } };
        observations.push(record);
        stepResults.push({ index, type: step.type, observationId: latest.id, evidenceId: record.id, url: latest.url, text: record.text });
      }
      continue;
    } else if (step.type === 'resize') observation = await browser.resize(step.width!, step.height!);
    else if (step.type === 'wait') {
      await delay(step.ms!, undefined, { signal });
      observation = await browser.observe();
    } else if (step.type === 'press')
      observation = await browser.act({ type: 'press', key: step.key as never, observationId: freshest().id });
    else {
      const before = freshest();
      // Industry practice, and the opposite of what this line did. Playwright MCP reports a stale
      // reference only for the call that used it - "Ref <ref> not found in the current page snapshot.
      // Try capturing new snapshot." - and never refuses the page; browser-use marks a truncated payload
      // explicitly instead of treating it as a veto. A truncated text window says nothing about the
      // control inventory, and refusing every control step because of it cost whole increments: a
      // measured replay reported all forty behaviours blocked, having completed only the first. So
      // resolution proceeds, and a control that genuinely cannot be resolved uniquely still fails in
      // `resolveControl` below - which is the guarantee the stale-ref test pins.
      const ref = await resolveControlWithFallback(input, before.refs, step, index);
      observation = step.type === 'click' ? await browser.act({ type: 'click', ref, observationId: before.id })
        : step.type === 'fill' ? await browser.act({ type: 'fill', ref, observationId: before.id, text: step.text ?? '' })
          : await browser.act({ type: 'select', ref, observationId: before.id, value: step.value ?? '' });
    }
    signal.throwIfAborted();
    latest = observation;
    const tree = truncate(observation.tree), text = truncate(observation.text);
    const record: ReplayObservation = { id: randomUUID(), behaviorId: program.behaviorId, action, observationId: observation.id,
      url: observation.url, tree: tree.text, text: text.text,
      truncated: observation.truncated || tree.truncated || text.truncated, ...(actionKey ? { key: actionKey } : {}) };
    observations.push(record);
    stepResults.push({ index, type: step.type, observationId: observation.id, evidenceId: record.id,
      url: observation.url, text: record.text });
  }

  signal.throwIfAborted();
  const targetMatches = new Map<number, ReplayTargetObservation['matches']>();
  for (const [index, assertion] of program.assertions.entries()) {
    if (!('target' in assertion)) continue;
    if (!browser.inspect) throw new RuntimeError('INVALID_TEST_PROGRAM', '当前浏览器不支持作用域目标检查');
    const inspected = await browser.inspect(assertion.target);
    signal.throwIfAborted();
    latest = inspected.observation;
    targetMatches.set(index, inspected.matches);
    const summary = truncate(JSON.stringify(assertion.kind === 'target-count' ? { target: assertion.target, count: inspected.matches.length } : { target: assertion.target, matches: inspected.matches }));
    observations.push({ id: randomUUID(), behaviorId: program.behaviorId, action: null, observationId: latest.id,
      url: latest.url, tree: truncate(latest.tree).text, text: summary.text, truncated: summary.truncated || latest.truncated });
  }
  // One logs() call per program, after the last step: an error count read before
  // the steps would judge the behaviour on the previous page state.
  const logs = await browser.logs();
  return finishProgram(input, { observations, stepResults, screenshots, latest, logs, targetMatches });
}

function finishProgram(input: ReplayRunInput, completed: {
  observations: ReplayObservation[]; stepResults: ReplayStepResult[]; screenshots: StoredArtifact[];
  latest: BrowserObservation | undefined; logs: Record<string, unknown>;
  targetMatches: ReadonlyMap<number, ReplayTargetObservation['matches']>;
}): ReplayProgramResult {
  const { program } = input;
  const { observations, stepResults, screenshots, latest, logs, targetMatches } = completed;
  const logged = truncate(latest?.text ?? '');
  const assertionResults = evaluateAssertions(program.assertions, { text: logged.text, refs: latest?.refs ?? {},
    observationText: latest?.text ?? '', logs, targetMatches });
  const assertionsPassed = assertionResults.every((result) => result.passed);
  // `finishReview` refuses a passed item whose observations hold no interaction
  // (generation.ts: the "actual action and follow-up observation" guard) unless
  // the sealed action is render-only and a screenshot backs it. A script whose
  // steps are all opens, waits and captures therefore has real observations but
  // no action proof: it reports blocked instead of passing, so this layer can
  // never manufacture a pass that the release gate would reject.
  const actionEvidence = observations.some((record) => record.action !== null && record.action !== 'wait');
  const renderEvidence = input.rendersOnly && observations.length >= 1 && screenshots.length > 0;
  const passable = actionEvidence || renderEvidence;
  const verdict = !passable ? 'blocked' as const
    : !assertionsPassed ? 'failed' as const : 'passed' as const;
  const scopeNotice = program.assertions.some(assertion => assertion.kind === 'text')
    ? '旧版页面文本检查（仅证明页面文本事实，不证明特定结果区域）：' : '';
  const summary = scopeNotice + assertionResults.map((result) => `${result.passed ? '✓' : '✗'} ${result.detail}`).join('；');
  const cited = observations.length <= 32 ? observations : observations.filter(record =>
    record === observations.find(candidate => candidate.action !== null && candidate.action !== 'wait') || observations.slice(-31).includes(record));
  const item = ReviewItemSchema.parse({
    behaviorId: program.behaviorId,
    verdict,
    expected: input.target.expected,
    actual: !passable ? `脚本断言成立，但步骤中没有真实交互动作，也没有可替代的渲染证据，无法判定通过。${summary}`
      : summary || `已执行 ${program.steps.length} 个步骤并观察结果`,
    observationEventIds: cited.map(record => record.id),
    screenshotIds: screenshots.map((artifact) => artifact.id).slice(0, 6),
    reproSteps: program.steps.map((step) => describeStep(step)).slice(0, 8),
  });
  return { item, observations, stepResults, screenshots, assertionResults, assertionsPassed,
    events: observations.map(toObservationEvent) };
}


/** One bounded program crosses the sandbox transport; assertions and artifact admission stay here. */
async function runNativeReplayProgram(input: ReplayRunInput): Promise<ReplayProgramResult> {
  const { browser, program, signal } = input;
  const targets = program.assertions.flatMap(assertion => 'target' in assertion ? [assertion.target] : []);
  const frames: BrowserProgramFrame[] = [];
  const resolvedRefs: Record<number, string> = {};
  let startIndex = 0;
  let resumeObservation: BrowserObservation | undefined;
  let response: BrowserProgramResponse;
  for (;;) {
    signal.throwIfAborted();
    response = await browser.executeProgram!({ steps: program.steps, initialState: program.initialState,
      targets, startIndex, observation: resumeObservation, resolvedRefs });
    signal.throwIfAborted();
    frames.push(...response.frames);
    if (response.error) throw new RuntimeError(response.error.code, `第 ${response.error.index + 1} 步：${response.error.message}`);
    if (!response.pending) break;
    const pending = response.pending;
    const step = program.steps[pending.index];
    if (!step || !['click', 'fill', 'select'].includes(step.type) || resolvedRefs[pending.index])
      throw new RuntimeError('STALE_BROWSER_REF', '控件解析后仍无法执行原步骤');
    const ref = await resolveControlWithFallback(input, pending.observation.refs,
      step as Extract<ReplayStep, { type: 'click' | 'fill' | 'select' }>, pending.index);
    resolvedRefs[pending.index] = ref;
    startIndex = pending.index; resumeObservation = pending.observation;
  }
  if (frames.length !== program.steps.length || frames.some((frame, index) => frame.index !== index))
    throw new RuntimeError('BROWSER_ACTION_FAILED', '浏览器程序没有完整的顺序执行证据');
  const observations: ReplayObservation[] = [];
  const stepResults: ReplayStepResult[] = [];
  const screenshots: StoredArtifact[] = [];
  let latest: BrowserObservation | undefined;
  for (const frame of frames) {
    const step = program.steps[frame.index];
    if (!step) throw new RuntimeError('BROWSER_BLOCKED', '浏览器返回了计划外步骤');
    if (frame.kind === 'screenshot') {
      if (step.type !== 'capture' || !latest || !frame.image) throw new RuntimeError('BROWSER_BLOCKED', '截图没有对应页面观察');
      const artifact = await input.saveScreenshot({ ...frame.image, observationId: latest.id }); screenshots.push(artifact);
      stepResults.push({ index: frame.index, type: step.type, observationId: latest.id,
        evidenceId: observations.at(-1)?.id ?? null, url: latest.url, text: latest.text, artifactId: artifact.id });
      continue;
    }
    if (!frame.observation) throw new RuntimeError('BROWSER_BLOCKED', '步骤缺少实际观察');
    latest = frame.observation;
    const tree = truncate(latest.tree), text = truncate(latest.text);
    if (step.type === 'key_sequence') {
      const keys = Array.from({ length: step.repeat }, () => step.keys).flat();
      if (!frame.batch || frame.batch.steps.length !== keys.length || frame.batch.steps.some((entry, index) => !entry.success || entry.key !== keys[index]))
        throw new RuntimeError('BROWSER_ACTION_FAILED', '键盘序列没有逐项完成证据');
    }
    const record: ReplayObservation = { id: randomUUID(), behaviorId: program.behaviorId, action: replayAction(step),
      observationId: latest.id, url: latest.url, tree: tree.text, text: text.text,
      truncated: latest.truncated || tree.truncated || text.truncated,
      ...(step.type === 'press' ? { key: step.key } : {}), ...(frame.batch ? { batch: frame.batch } : {}) };
    observations.push(record); stepResults.push({ index: frame.index, type: step.type, observationId: latest.id,
      evidenceId: record.id, url: latest.url, text: record.text });
  }
  const targetMatches = new Map<number, ReplayTargetObservation['matches']>();
  let scopeIndex = 0;
  for (const [index, assertion] of program.assertions.entries()) {
    if (!('target' in assertion)) continue;
    const inspected = response.inspections?.[scopeIndex++];
    if (!inspected || JSON.stringify(inspected.target) !== JSON.stringify(assertion.target))
      throw new RuntimeError('BROWSER_BLOCKED', '作用域检查与原断言不匹配');
    latest = inspected.observation; targetMatches.set(index, inspected.matches);
    const summary = truncate(JSON.stringify(assertion.kind === 'target-count' ? { target: assertion.target, count: inspected.matches.length } : { target: assertion.target, matches: inspected.matches }));
    observations.push({ id: randomUUID(), behaviorId: program.behaviorId, action: null, observationId: latest.id,
      url: latest.url, tree: truncate(latest.tree).text, text: summary.text, truncated: summary.truncated || latest.truncated });
  }
  signal.throwIfAborted();
  return finishProgram(input, { observations, stepResults, screenshots, latest, targetMatches, logs: response.logs ?? {} });
}

function describeStep(step: ReplayStep): string {
  if (step.type === 'open') return `打开 ${step.path ?? '/'}`;
  if (step.type === 'reload') return '刷新当前页面';
  if (step.type === 'resize') return `调整视口 ${step.width}×${step.height}`;
  if (step.type === 'press') return `按键 ${step.key}`;
  if (step.type === 'key_sequence') return `执行 ${step.keys.length * step.repeat} 个真实按键`;
  if (step.type === 'wait') return `等待 ${step.ms}ms`;
  if (step.type === 'capture') return '截图';
  return `${step.type} ${step.role ?? 'button'}/${JSON.stringify(step.name ?? '')}`;
}
/** The kernel's record is the reviewer's observation shape, minus the fields only the model loop can fill. */
export function toObservationEvent(record: ReplayObservation): ReviewObservationEvent {
  return { id: record.id, behaviorId: record.behaviorId, action: record.action, observationId: record.observationId,
    url: record.url, tree: record.tree, text: record.text, truncated: record.truncated,
    ...(record.key ? { key: record.key } : {}), ...(record.batch ? { batch: record.batch } : {}) };
}
