import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ReviewItemSchema, type BehaviorAssertion, type BehaviorStep, type BehaviorTarget } from '@pivloom/contracts';
import { RuntimeError } from './types.js';
import type { ReviewObservationEvent } from './reviewer.js';
import type { BrowserAction, BrowserObservation } from './browser.js';
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
  saveScreenshot(image: { base64: string; mimeType: 'image/png'; sha256: string }): Promise<StoredArtifact>;
}
/**
 * The subset of `ReviewBrowser` the kernel needs. It is structurally compatible
 * with `ReviewBrowser`, so the caller passes the real browser, while the kernel
 * cannot reach the fields a script has no plan vocabulary for (a key batch's
 * tick timing stays a model judgement and never becomes a replay step).
 */
export interface ReplayBrowser {
  readonly sessionId: string;
  open(path?: string): Promise<BrowserObservation>;
  observe(): Promise<BrowserObservation>;
  resize(width: number, height: number): Promise<BrowserObservation>;
  act(action: BrowserAction): Promise<BrowserObservation>;
  logs(): Promise<Record<string, unknown>>;
  screenshot(): Promise<{ base64: string; mimeType: 'image/png'; sha256: string }>;
}
/**
 * Playwright's default for `getByRole(name)`: trimmed and case-insensitive, matching a substring unless
 * `exact` is asked for. Ours demanded character-for-character equality, which failed a plan that clicked a
 * button named "=" against an application that names it something else, and could not reach
 * "删除 2+3 = 5" from "删除". Substring matching does not weaken uniqueness - the caller still requires
 * exactly one match - so twenty identically named buttons remain an error, as they should.
 */
const matchesAccessibleName = (actual: string | undefined, wanted: string): boolean => {
  if (actual === undefined) return false;
  const want = wanted.trim().toLowerCase();
  return want.length > 0 && actual.trim().toLowerCase().includes(want);
};

const REF = /^e[0-9]{1,6}$/;
/** Same bound as the reviewer's observation record: one step must not persist an
 * unbounded accessibility snapshot into the check's evidence. */
const OBSERVATION_TEXT_LIMIT = 32_000;
const TRUNCATION_SUFFIX = '…[truncated]';

function truncate(text: string): { text: string; truncated: boolean; textLength: number } {
  // The length travels with the value: knowing only that an observation was cut says nothing about
  // whether the window is slightly too small or the page is pathological, and those need opposite
  // fixes. A recorded run could say no more than "the observation was incomplete".
  return text.length <= OBSERVATION_TEXT_LIMIT
    ? { text, truncated: false, textLength: text.length }
    : { text: `${text.slice(0, OBSERVATION_TEXT_LIMIT)}${TRUNCATION_SUFFIX}`, truncated: true, textLength: text.length };
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
  },
): ReplayAssertionResult[] {
  const consoleErrors = Array.isArray(evidence.logs.errors) ? evidence.logs.errors.length : 0;
  return assertions.map((assertion, index) => {
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
    .filter(([key, target]) => REF.test(key) && target.role === step.role && matchesAccessibleName(target.name, step.name))
    .map(([key]) => key);
  if (matches.length !== 1)
    throw new RuntimeError('STALE_BROWSER_REF',
      `第 ${index + 1} 步控件不唯一或已改变（role=${step.role} name=${JSON.stringify(step.name)} 匹配 ${matches.length} 个），请重新观察`);
  return matches[0];
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
  signal.throwIfAborted();

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
      const artifact = await input.saveScreenshot(image);
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
    // Carried as a local rather than on the record: the observation record must stay exactly the
    // reviewer's evidence shape, and a test pins that. This is only for the message below.
    let observedTextLength = 0;
    if (step.type === 'open') observation = await browser.open(step.path ?? '/');
    else if (step.type === 'reload') {
      // A reload is bound to the page the check is actually on: reconstructing it
      // from the newest observation is what makes it a persistence check rather
      // than a fresh first open, which the reviewer treats as non-behavioural.
      const url = new URL(freshest().url);
      observation = await browser.open(url.pathname + url.search + url.hash);
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
      const ref = resolveControl(before.refs, step, index);
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
    observedTextLength = text.textLength;
    observations.push(record);
    stepResults.push({ index, type: step.type, observationId: observation.id, evidenceId: record.id,
      url: observation.url, text: record.text });
  }

  signal.throwIfAborted();
  // One logs() call per program, after the last step: an error count read before
  // the steps would judge the behaviour on the previous page state.
  const logs = await browser.logs();
  const logged = truncate(latest?.text ?? '');
  const assertionResults = evaluateAssertions(program.assertions, { text: logged.text, refs: latest?.refs ?? {},
    observationText: latest?.text ?? '', logs });
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
  const summary = assertionResults.map((result) => `${result.passed ? '✓' : '✗'} ${result.detail}`).join('；');
  const item = ReviewItemSchema.parse({
    behaviorId: program.behaviorId,
    verdict,
    expected: input.target.expected,
    actual: !passable ? `脚本断言成立，但步骤中没有真实交互动作，也没有可替代的渲染证据，无法判定通过。${summary}`
      : summary || `已执行 ${program.steps.length} 个步骤并观察结果`,
    observationEventIds: observations.map((record) => record.id).slice(0, 32),
    screenshotIds: screenshots.map((artifact) => artifact.id).slice(0, 6),
    reproSteps: program.steps.map((step) => describeStep(step)).slice(0, 8),
  });
  return { item, observations, stepResults, screenshots, assertionResults, assertionsPassed,
    events: observations.map(toObservationEvent) };
}

function describeStep(step: ReplayStep): string {
  if (step.type === 'open') return `打开 ${step.path ?? '/'}`;
  if (step.type === 'reload') return '刷新当前页面';
  if (step.type === 'resize') return `调整视口 ${step.width}×${step.height}`;
  if (step.type === 'press') return `按键 ${step.key}`;
  if (step.type === 'wait') return `等待 ${step.ms}ms`;
  if (step.type === 'capture') return '截图';
  return `${step.type} ${step.role ?? 'button'}/${JSON.stringify(step.name ?? '')}`;
}
/** The kernel's record is the reviewer's observation shape, minus the fields only the model loop can fill. */
export function toObservationEvent(record: ReplayObservation): ReviewObservationEvent {
  return { id: record.id, behaviorId: record.behaviorId, action: record.action, observationId: record.observationId,
    url: record.url, tree: record.tree, text: record.text, truncated: record.truncated,
    ...(record.key ? { key: record.key } : {}) };
}
