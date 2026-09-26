import { randomUUID } from 'node:crypto';
import { expect, test, vi } from 'vitest';
import { HandoffSchema, ReviewBindingSchema, type Handoff, type Plan } from '@pivloom/contracts';
import { captureVisualPrograms, compilePlan, runPrograms, runScriptedPlan, type ReplayUncompilable } from '../../src/runtime/replay-plan.js';
import { assertReviewerResult } from '../../src/runtime/reviewer.js';
import type { ProbeEvent } from '../../src/runtime/types.js';
import type { StoredArtifact } from '../../src/storage/artifacts.js';
import { createMeaningfulProgressGate } from '../../src/generation/progress-watchdog.js';
import { parseReviewEvidence } from '../../src/data/generation.js';
import { REVIEW_WALL_CLOCK_BUDGET_MS, VERIFICATION_WALL_CLOCK_LIMIT_MS } from '../../src/runtime/budgets.js';
import { formFixture, PNG_BASE64, PNG_SHA256 } from './replay-fixture.js';

const PROJECT = randomUUID();
const REVISION = randomUUID();
const SESSION = 'pivloom-11111111-2222-4333-8444-555555555555';
function fixturePlan(overrides: Partial<Plan['behaviors'][number]> = {}, extra: Partial<Plan['behaviors'][number]> = {}): Plan {
  return { schemaVersion: 1, goal: '新增书籍', changeSummary: '新增书籍', assumptions: [], outOfScope: [],
    behaviors: [{ id: 'B01', title: '添加', precondition: '空书单', action: '点击添加按钮', expected: '出现测试书名', required: true,
      steps: [{ type: 'open', path: '/' }, { type: 'click', role: 'button', name: '添加' }],
      assertions: [{ kind: 'text', text: '测试书名', negated: false }], ...overrides, ...extra }] };
}
function binding(roleRunId: string) {
  return ReviewBindingSchema.parse({ runId: randomUUID(), roleRunId, attempt: 0, revisionId: REVISION,
    sourceHash: 'a'.repeat(64), sandboxId: 'fixture-sandbox', browserSessionId: SESSION });
}
function handoffFor(plan: Plan, value = binding(randomUUID())): Handoff {
  return HandoffSchema.parse({ runId: value.runId, fromRoleRunId: null, toRole: 'reviewer', attempt: 0, baseRevisionId: null,
    expectedRevisionId: value.revisionId, sourceHash: value.sourceHash, plan, task: '检查新增书籍', artifactIds: [] });
}
/** Records artifact keys exactly as the artifact store does, so the save-path key check can be exercised. */
function screenshotSink(scope: { ownerId: string; projectId: string; revisionId: string }) {
  const saved: StoredArtifact[] = [];
  return { saved, save: async (image: { base64: string; mimeType: 'image/png'; sha256: string }): Promise<StoredArtifact> => {
    const id = randomUUID();
    const artifact: StoredArtifact = { ...image, id, key: `${scope.ownerId}/${scope.projectId}/${scope.revisionId}/checks/${id}.png`, bytes: 68 };
    saved.push(artifact);
    return artifact;
  } };
}
function uncompilableReason(items: ReplayUncompilable[], behaviorId: string) {
  return items.find((item) => item.behaviorId === behaviorId)?.reason;
}

test('a plan with nothing compiled falls back before any browser work', async () => {
  // The only plan that still returns to the model path: every behaviour is uncompilable and no judge is
  // supplied, so there is no deterministic or pixel verdict to keep. Nothing was driven, which is why
  // the model path can start from the untouched page.
  const plan = fixturePlan({ steps: undefined, assertions: undefined });
  const compiled = compilePlan(plan);
  expect(compiled.programs).toEqual([]);
  expect(compiled.uncompilable).toEqual([{ behaviorId: 'B01', reason: 'missing-steps' }]);
  const fixture = formFixture(SESSION);
  const value = binding(randomUUID());
  const outcome = await runScriptedPlan({ binding: value, handoff: handoffFor(plan, value), browser: fixture.browser,
    signal: new AbortController().signal, saveScreenshot: screenshotSink({ ownerId: PROJECT, projectId: PROJECT, revisionId: REVISION }).save });
  expect(outcome.kind).toBe('fallback');
  // No compiled program means no browser work and, crucially, no renewal events:
  // the model path will make its own progress from here.
  expect(fixture.calls.open).toBe(0);
});

test('steps without assertions are uncompilable, and a visual behaviour is never judged by text', () => {
  const noAssertions = compilePlan(fixturePlan({ assertions: undefined }));
  expect(uncompilableReason(noAssertions.uncompilable, 'B01')).toBe('missing-assertions');
  const visual = compilePlan(fixturePlan({ evidence: 'visual' }));
  expect(visual.programs).toEqual([]);
  expect(uncompilableReason(visual.uncompilable, 'B01')).toBe('visual-evidence');
});

test('a compiled plan runs with zero model requests and emits one trusted completion per program', async () => {
  const plan = fixturePlan();
  const value = binding(randomUUID());
  const fixture = formFixture(SESSION, { after: { 1: { text: '测试书名' } } });
  const sink = screenshotSink({ ownerId: PROJECT, projectId: PROJECT, revisionId: REVISION });
  const events: Array<{ type: string; toolName?: string; success?: boolean }> = [];
  const outcome = await runScriptedPlan({ binding: value, handoff: handoffFor(plan, value), browser: fixture.browser,
    signal: new AbortController().signal, saveScreenshot: sink.save,
    onEvent: async (event) => { events.push({ type: event.type, toolName: event.toolName, success: event.success }); } });
  expect(outcome.kind).toBe('scripted');
  if (outcome.kind !== 'scripted') return;
  // There is no provider client anywhere in this call: the script is the whole
  // driver, so a model request is impossible rather than merely uncounted.
  const completed = events.filter((event) => event.type === 'tool.end');
  expect(completed).toEqual([{ type: 'tool.end', toolName: 'browser_steps', success: true }]);
  assertReviewerResult(outcome.result);
  expect(outcome.result.usage).toMatchObject({ modelCalls: 0, toolCalls: 0, source: 'unreported' });
  expect(outcome.result.chromeClosed).toBe(true);
  expect(outcome.result.result.items).toMatchObject([{ behaviorId: 'B01', verdict: 'passed', expected: '出现测试书名' }]);
  expect(outcome.result.evidence.length).toBeGreaterThan(0);
  parseReviewEvidence(outcome.result.evidence);
  // The result's artifact list is the store's own records, so the storage key the
  // save path requires is already attached to exactly the ids the item cites.
  for (const artifact of outcome.result.artifacts)
    expect(sink.saved.find((saved) => saved.id === artifact.id)?.key)
      .toBe(`${PROJECT}/${PROJECT}/${REVISION}/checks/${artifact.id}.png`);
});

test('a genuinely failing assertion is submitted as failed rather than falling back', async () => {
  const plan = fixturePlan({}, { assertions: [{ kind: 'text', text: '不会出现的文字', negated: false }] });
  const value = binding(randomUUID());
  const fixture = formFixture(SESSION, { after: { 1: { text: '测试书名' } } });
  const outcome = await runScriptedPlan({ binding: value, handoff: handoffFor(plan, value), browser: fixture.browser,
    signal: new AbortController().signal, saveScreenshot: screenshotSink({ ownerId: PROJECT, projectId: PROJECT, revisionId: REVISION }).save });
  expect(outcome.kind).toBe('scripted');
  if (outcome.kind !== 'scripted') return;
  expect(outcome.result.result.items).toMatchObject([{ behaviorId: 'B01', verdict: 'failed' }]);
});

test('a partially compilable plan keeps the compiled verdict and blocks only the unexecutable behaviour', async () => {
  // The mechanism this replaces measured a real run: 35 behaviours had already produced verdicts when 4
  // could not compile, and the whole check was sent back to the model path (130 actions, ~30 minutes).
  // Nothing here justifies redoing the compiled half, so it keeps its own verdict and the model-free
  // result is submitted with the unexecutable behaviour marked blocked.
  const compiledPlan = fixturePlan();
  const plan: Plan = { ...compiledPlan, behaviors: [compiledPlan.behaviors[0],
    { ...compiledPlan.behaviors[0], id: 'B02', title: '拖拽排序', steps: undefined, assertions: undefined }] };
  const value = binding(randomUUID());
  const fixture = formFixture(SESSION, { after: { 1: { text: '测试书名' } } });
  const outcome = await runScriptedPlan({ binding: value, handoff: handoffFor(plan, value), browser: fixture.browser,
    signal: new AbortController().signal, saveScreenshot: screenshotSink({ ownerId: PROJECT, projectId: PROJECT, revisionId: REVISION }).save });
  expect(outcome.kind).toBe('scripted');
  if (outcome.kind !== 'scripted') return;
  assertReviewerResult(outcome.result);
  expect(outcome.result.result.items).toMatchObject([
    { behaviorId: 'B01', verdict: 'passed', expected: '出现测试书名' },
    { behaviorId: 'B02', verdict: 'blocked', expected: '出现测试书名' },
  ]);
  // The blocked verdict names the planning gap, and blocked is not a pass: the fail-closed rule is
  // unchanged and `finishReview` still refuses to accept the candidate.
  expect(String(outcome.result.result.items[1].actual)).toContain('missing-steps');
  expect(outcome.result.result.items[1].observationEventIds).toEqual([]);
  // The compiled behaviour really ran the browser once, and the unexecutable one drove nothing.
  expect(fixture.calls.open).toBe(1);
  expect(outcome.result.usage.modelCalls).toBe(0);
});

test('runPrograms reports each program to the progress hook only after it finished', async () => {
  const plan = fixturePlan();
  const fixture = formFixture(SESSION, { after: { 1: { text: '测试书名' } } });
  const completed: string[] = [];
  const result = await runPrograms(compilePlan(plan), { browser: fixture.browser, behaviors: plan.behaviors,
    signal: new AbortController().signal, saveScreenshot: screenshotSink({ ownerId: PROJECT, projectId: PROJECT, revisionId: REVISION }).save,
    onProgress: async (program) => { completed.push(program.behaviorId); expect(fixture.actions).toHaveLength(1); } });
  expect(completed).toEqual(['B01']);
  expect(result.items.get('B01')!.verdict).toBe('passed');
  expect(result.artifacts.every((artifact) => artifact.sha256 === PNG_SHA256)).toBe(true);
});

test('a stale control blocks the behaviour that named it and never clicks blindly', async () => {
  // This replaces a test that required the whole scripted pass to reject. Two guarantees live here and
  // both are kept. The first is the one that matters most: a control that does not resolve is never
  // clicked anyway, which is also why Playwright's docs discourage first()/nth() - a changed page makes
  // them hit the wrong element. The second is what changed: the failure belongs to the behaviour that
  // named the missing control, so the other behaviours keep their results, as Momentic, Octomind and
  // QA Wolf all do rather than discarding a whole run for one unresolvable element.
  const plan = fixturePlan({ steps: [{ type: 'open', path: '/' }, { type: 'click', role: 'button', name: '不存在' }] });
  const value = binding(randomUUID());
  const fixture = formFixture(SESSION);
  const outcome = await runScriptedPlan({ binding: value, handoff: handoffFor(plan, value), browser: fixture.browser,
    signal: new AbortController().signal, saveScreenshot: screenshotSink({ ownerId: PROJECT, projectId: PROJECT, revisionId: REVISION }).save });
  expect(outcome.kind).toBe('scripted');
  if (outcome.kind !== 'scripted') return;
  const [item] = outcome.result.result.items;
  expect(item).toMatchObject({ behaviorId: 'B01', verdict: 'blocked' });
  // The reason is machine-readable, not a bare 'something failed'.
  expect(String(item.actual)).toContain('STALE_BROWSER_REF');
  expect(fixture.calls.act).toBe(0);
});

test('the renewal event the scripted pass emits is one the run watchdog accepts as progress', async () => {
  const plan = fixturePlan();
  const value = binding(randomUUID());
  const fixture = formFixture(SESSION, { after: { 1: { text: '测试书名' } } });
  const events: ProbeEvent[] = [];
  await runScriptedPlan({ binding: value, handoff: handoffFor(plan, value), browser: fixture.browser,
    signal: new AbortController().signal, saveScreenshot: screenshotSink({ ownerId: PROJECT, projectId: PROJECT, revisionId: REVISION }).save,
    onEvent: async (event) => { events.push(event); } });
  const completion = events.find((event) => event.type === 'tool.end')!;
  expect(completion).toMatchObject({ toolName: 'browser_steps', success: true });
  // The gate is the actual predicate executor.ts uses before it calls appendEvent
  // with progress:true, so this is the renewal contract, not a copy of it.
  const gate = createMeaningfulProgressGate();
  expect(gate(value.roleRunId, completion)).toBe(true);
  // The same event with a tool the whitelist does not contain is not progress: the
  // A layer may not invent a new tool name to keep a run alive.
  expect(gate(value.roleRunId, { ...completion, toolName: 'replay' })).toBe(false);
  expect(gate(value.roleRunId, { ...completion, success: false })).toBe(false);
});

test('a handoff from another revision or browser session never drives this candidate', async () => {
  const plan = fixturePlan();
  const value = binding(randomUUID());
  const fixture = formFixture(SESSION);
  const foreign = { ...handoffFor(plan, value), sourceHash: 'b'.repeat(64) };
  await expect(runScriptedPlan({ binding: value, handoff: foreign, browser: fixture.browser,
    signal: new AbortController().signal, saveScreenshot: screenshotSink({ ownerId: PROJECT, projectId: PROJECT, revisionId: REVISION }).save }))
    .rejects.toMatchObject({ code: 'INVALID_HANDOFF' });
  expect(fixture.calls.open).toBe(0);
});

test("a visual behaviour is driven and its pixels kept for the judge, without a model in the path", async () => {
  // The plan contract puts appearance behaviours in the uncompilable list, so their steps have never
  // run and no screenshot exists. This is the piece that runs them and keeps the pixels; the judge
  // that reads them afterwards never receives a browser.
  const fixture = formFixture(SESSION);
  const plan = fixturePlan({ evidence: 'visual' },
    { steps: [{ type: 'open', path: '/' }, { type: 'click', role: 'button', name: '添加' }, { type: 'capture' }] });
  const stored: StoredArtifact[] = [];
  const attributed: Array<{ behaviorId: string; observationId: string }> = [];
  const captures = await captureVisualPrograms({
    behaviors: plan.behaviors,
    browser: fixture.browser,
    signal: new AbortController().signal,
    async saveScreenshot(image) {
      attributed.push({ behaviorId: image.behaviorId, observationId: image.observationId });
      const artifact = { id: randomUUID(), mimeType: image.mimeType, sha256: image.sha256 } as StoredArtifact;
      stored.push(artifact);
      return artifact;
    },
  });
  const captured = captures.get('B01');
  // The browser really was driven, and the pixels really were kept: a judge handed an empty list
  // could only repeat the expectation back.
  expect(fixture.calls.act).toBeGreaterThan(0);
  expect(captured?.images[0]?.base64).toBe(PNG_BASE64);
  expect(captured?.artifactIds).toEqual(stored.map((artifact) => artifact.id));
  // The image must be attributable to the behaviour and to the observation whose pixels it is; the
  // click is the newest observation when the capture marker runs, so that is the one it belongs to.
  expect(attributed).toEqual([{ behaviorId: 'B01', observationId: fixture.observations.at(-1)!.id }]);
  // The evidence and artifacts travel back with the pixels: without them the merged item's ids
  // would not resolve against what `finishReview` persists.
  parseReviewEvidence(captured!.evidence);
  expect(captured!.artifacts.map((artifact) => artifact.id)).toEqual(captured!.artifactIds);
  // The item echoes the sealed expectation rather than anything a model said.
  expect(captured?.item.expected).toBe('出现测试书名');
});

test("the capture path holds no provider transport, so nothing can call a model", async () => {
  // `captureVisualPrograms` takes no model config and imports no provider client, so the honest
  // runtime proof is that the transport a provider request would use was never reached at all.
  const fetchStub = vi.fn(async () => { throw new Error('the capture layer must not call a model'); });
  vi.stubGlobal('fetch', fetchStub);
  try {
    const fixture = formFixture(SESSION);
    const plan = fixturePlan({ evidence: 'visual', action: '查看首屏账单区域' },
      { steps: [{ type: 'open', path: '/' }, { type: 'capture' }] });
    const captures = await captureVisualPrograms({
      behaviors: plan.behaviors, browser: fixture.browser, signal: new AbortController().signal,
      async saveScreenshot(image) {
        return { id: randomUUID(), mimeType: image.mimeType, sha256: image.sha256 } as StoredArtifact;
      },
    });
    expect(captures.get('B01')?.images).toHaveLength(1);
    expect(fetchStub).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); }
});

test("a visual behaviour with no steps is skipped rather than driven", async () => {
  // With no steps nothing says what to drive, so it stays uncompilable for a reason other than
  // appearance and the caller keeps the whole-plan fallback. Skipping is deliberate, not a silent drop.
  const fixture = formFixture(SESSION);
  const plan = fixturePlan({ evidence: 'visual' }, { steps: undefined });
  const captures = await captureVisualPrograms({
    behaviors: plan.behaviors, browser: fixture.browser, signal: new AbortController().signal,
    async saveScreenshot() { throw new Error('nothing should be captured'); },
  });
  expect(captures.size).toBe(0);
  expect(fixture.calls.act).toBe(0);
});

/**
 * An appearance-only plan: `compilePlan` compiles no program for it and puts the behaviour in the
 * uncompilable list with reason `visual-evidence`. That is the trap the wiring has to survive: the
 * plan has zero programs, yet it is the one plan the visual path exists for.
 */
function visualOnlyPlan(overrides: Partial<Plan['behaviors'][number]> = {}): Plan {
  return fixturePlan({ evidence: 'visual', action: '查看首屏账单区域', expected: '结算区域显示金额 12.00 且靠右对齐',
    steps: [{ type: 'open', path: '/' }, { type: 'capture' }],
    assertions: [{ kind: 'text', text: '空书单', negated: false }], ...overrides });
}
/** The injected port: the module may reach a model only through this, and only with pixels it captured. */
function judgePort(reply: string | ((prompt: string, images: Array<{ base64: string; mimeType: string }>) => string),
  now?: () => number) {
  const calls: Array<{ prompt: string; images: Array<{ base64: string; mimeType: string }> }> = [];
  return { calls, port: { async request(prompt: string, images: Array<{ base64: string; mimeType: string }>) {
    calls.push({ prompt, images });
    return typeof reply === 'string' ? reply : reply(prompt, images);
  }, ...(now ? { now } : {}) } };
}
async function runVisual(plan: Plan, judge: ReturnType<typeof judgePort>) {
  const value = binding(randomUUID());
  const fixture = formFixture(SESSION);
  const sink = screenshotSink({ ownerId: PROJECT, projectId: PROJECT, revisionId: REVISION });
  const outcome = await runScriptedPlan({ binding: value, handoff: handoffFor(plan, value), browser: fixture.browser,
    signal: new AbortController().signal, saveScreenshot: sink.save, visualJudge: judge.port });
  return { outcome, fixture, sink };
}

test('an all-appearance plan is judged from captured pixels instead of falling back', async () => {
  const plan = visualOnlyPlan();
  // Zero programs is the fact that used to force the whole-plan fallback before anything could look
  // at the pixels; this plan must take the visual path precisely because of it.
  expect(compilePlan(plan).programs).toEqual([]);
  expect(compilePlan(plan).uncompilable).toEqual([{ behaviorId: 'B01', reason: 'visual-evidence' }]);
  const judge = judgePort(JSON.stringify({ judgements: [{ id: 'B01', verdict: 'passed',
    citation: '右上角金额显示 12.00，右对齐' }] }));
  const { outcome, fixture, sink } = await runVisual(plan, judge);
  expect(outcome.kind).toBe('scripted');
  if (outcome.kind !== 'scripted') return;
  assertReviewerResult(outcome.result);
  const [item] = outcome.result.result.items;
  expect(item).toMatchObject({ behaviorId: 'B01', verdict: 'passed', expected: plan.behaviors[0].expected });
  // The model was handed the pixels the kernel actually took, together with the sealed expectation;
  // nothing here can hand it a browser, which is why the judged pass costs one request.
  expect(judge.calls).toHaveLength(1);
  expect(judge.calls[0].images[0]).toMatchObject({ base64: PNG_BASE64, mimeType: 'image/png' });
  expect(judge.calls[0].prompt).toContain(plan.behaviors[0].expected);
  expect(fixture.calls.open).toBe(1);
  expect(fixture.calls.screenshot).toBe(1);
  // Every id the item cites resolves in exactly the evidence and artifacts this run produced, and
  // the artifact key is the shape the persist path requires.
  const evidenceIds = new Set(outcome.result.evidence.map((event) => event.id));
  expect(item.observationEventIds.length).toBeGreaterThan(0);
  expect(item.observationEventIds.every((id) => evidenceIds.has(id))).toBe(true);
  const artifactIds = new Set(outcome.result.artifacts.map((artifact) => artifact.id));
  expect(item.screenshotIds).toHaveLength(1);
  expect(item.screenshotIds.every((id) => artifactIds.has(id))).toBe(true);
  expect(sink.saved[0]?.key).toBe(`${PROJECT}/${PROJECT}/${REVISION}/checks/${sink.saved[0]?.id}.png`);
  parseReviewEvidence(outcome.result.evidence);
});

test('a restated citation or an unparseable answer blocks the appearance behaviour', async () => {
  const plan = visualOnlyPlan();
  for (const answer of [
    // Restating the expectation needs no pixels at all, so it cannot count as having looked.
    JSON.stringify({ judgements: [{ id: 'B01', verdict: 'passed', citation: plan.behaviors[0].expected }] }),
    'I think it looks fine.',
  ]) {
    const judge = judgePort(answer);
    const { outcome } = await runVisual(plan, judge);
    expect(outcome.kind).toBe('scripted');
    if (outcome.kind !== 'scripted') return;
    // The result is still assembled and marked; it is the item that may not pass.
    assertReviewerResult(outcome.result);
    expect(outcome.result.result.items[0]).toMatchObject({ behaviorId: 'B01', verdict: 'blocked',
      expected: plan.behaviors[0].expected });
  }
});

test('a judgement past the review budget blocks without ever asking the model', async () => {
  const plan = visualOnlyPlan();
  // The clock jumps past the review share between the judge's start reading and its admission check,
  // which is the state an over-budget check is in; no eight-minute wait is needed to prove it.
  let readings = 0;
  const judge = judgePort(JSON.stringify({ judgements: [{ id: 'B01', verdict: 'passed', citation: '右上角 12.00' }] }),
    () => (readings++ === 0 ? 0 : REVIEW_WALL_CLOCK_BUDGET_MS + 1));
  const started = performance.now();
  const { outcome } = await runVisual(plan, judge);
  const elapsed = performance.now() - started;
  expect(outcome.kind).toBe('scripted');
  if (outcome.kind !== 'scripted') return;
  assertReviewerResult(outcome.result);
  expect(outcome.result.result.items[0]).toMatchObject({ behaviorId: 'B01', verdict: 'blocked' });
  // Admitting on the clock is the point: an over-budget judgement spends no request at all.
  expect(judge.calls).toHaveLength(0);
  // And the check returned instead of waiting the budget out, inside both ceilings.
  expect(elapsed).toBeLessThan(REVIEW_WALL_CLOCK_BUDGET_MS);
  expect(elapsed).toBeLessThan(VERIFICATION_WALL_CLOCK_LIMIT_MS);
});

test('a plan with a compiled, an appearance and an unexecutable behaviour settles each one on its own', async () => {
  // One non-appearance reason used to force the whole-plan fallback even with a judge supplied. Each
  // behaviour is now settled by the layer that can decide it, and nothing is re-run on the model path:
  // B01 by its scripted assertion, B02 from the pixels its own steps captured, B03 blocked with its
  // reason because the plan states no steps for it.
  const compiledBehavior = { ...fixturePlan().behaviors[0],
    // Decidable on the untouched fixture page, so the scripted half's own verdict is a real pass
    // regardless of what the later capture does to the page.
    assertions: [{ kind: 'control' as const, role: 'button', name: '添加', negated: false }] };
  const plan: Plan = { ...fixturePlan(), behaviors: [
    compiledBehavior,
    { ...visualOnlyPlan().behaviors[0], id: 'B02', title: '外观', required: true },
    { ...compiledBehavior, id: 'B03', title: '拖拽排序', steps: undefined, assertions: undefined },
  ] };
  const judge = judgePort(JSON.stringify({ judgements: [{ id: 'B02', verdict: 'passed', citation: '右上角 12.00' }] }));
  const { outcome, fixture } = await runVisual(plan, judge);
  expect(outcome.kind).toBe('scripted');
  if (outcome.kind !== 'scripted') return;
  assertReviewerResult(outcome.result);
  expect(outcome.result.result.items).toMatchObject([
    { behaviorId: 'B01', verdict: 'passed' },
    { behaviorId: 'B02', verdict: 'passed', actual: '右上角 12.00' },
    { behaviorId: 'B03', verdict: 'blocked' },
  ]);
  expect(String(outcome.result.result.items[2].actual)).toContain('missing-steps');
  expect(judge.calls).toHaveLength(1);
  // The compiled half really ran the browser (its click), and the appearance behaviour's capture marker
  // took the one screenshot the judge was handed.
  expect(fixture.calls.act).toBe(1);
  expect(fixture.calls.screenshot).toBe(1);
  expect(judge.calls[0].images[0]).toMatchObject({ base64: PNG_BASE64 });
});

test('an appearance behaviour with no judge is blocked rather than left without an item or judged by text', async () => {
  // A model that failed the vision probe supplies no port, so the pixels this behaviour needs cannot be
  // read. It must still get an item — the plan's every behaviour has to be accounted for — and that item
  // is blocked, because a text-only guess at an appearance verdict is the fail-open case the vision gate
  // exists to prevent.
  const plan: Plan = { ...fixturePlan(), behaviors: [fixturePlan().behaviors[0],
    { ...visualOnlyPlan().behaviors[0], id: 'B02' }] };
  const value = binding(randomUUID());
  const fixture = formFixture(SESSION, { after: { 1: { text: '测试书名' } } });
  const outcome = await runScriptedPlan({ binding: value, handoff: handoffFor(plan, value), browser: fixture.browser,
    signal: new AbortController().signal, saveScreenshot: screenshotSink({ ownerId: PROJECT, projectId: PROJECT, revisionId: REVISION }).save });
  expect(outcome.kind).toBe('scripted');
  if (outcome.kind !== 'scripted') return;
  expect(outcome.result.result.items).toMatchObject([
    { behaviorId: 'B01', verdict: 'passed' },
    { behaviorId: 'B02', verdict: 'blocked', expected: '结算区域显示金额 12.00 且靠右对齐' },
  ]);
  expect(String(outcome.result.result.items[1].actual)).toContain('visual-evidence');
  // Nothing was captured for it and nothing else was re-run: only the compiled behaviour drove the page.
  expect(fixture.calls.screenshot).toBe(0);
  expect(fixture.calls.open).toBe(1);
});

test('a plan where nothing compiles and nothing can be judged still falls back as a whole', async () => {
  // The one state that still returns to the model path: no program ran and no behaviour carries both the
  // steps and the stated expectation the appearance layer needs, so no deterministic verdict exists to
  // keep. A judge being configured does not turn a walkthrough into a pixel judgement.
  const plan: Plan = { ...fixturePlan(), behaviors: [
    { ...fixturePlan().behaviors[0], id: 'B01', steps: undefined, assertions: undefined },
    { ...visualOnlyPlan().behaviors[0], id: 'B02', assertions: undefined },
  ] };
  expect(compilePlan(plan).programs).toEqual([]);
  expect(compilePlan(plan).uncompilable).toEqual([{ behaviorId: 'B01', reason: 'missing-steps' },
    { behaviorId: 'B02', reason: 'missing-assertions' }]);
  const judge = judgePort(JSON.stringify({ judgements: [{ id: 'B02', verdict: 'passed', citation: '看似正常' }] }));
  const { outcome, fixture } = await runVisual(plan, judge);
  expect(outcome.kind).toBe('fallback');
  if (outcome.kind !== 'fallback') return;
  expect(outcome.uncompilable).toEqual([{ behaviorId: 'B01', reason: 'missing-steps' },
    { behaviorId: 'B02', reason: 'missing-assertions' }]);
  expect(judge.calls).toHaveLength(0);
  expect(fixture.calls.open).toBe(0);
});


test('a model verdict cannot turn a script-failed appearance behaviour into a pass', async () => {
  // The scripted assertion already found the candidate wrong, so a judgement that says otherwise must
  // not be able to upgrade it. Guarding only the blocked case allowed exactly that, which is fail-open
  // in the one direction that matters: the deterministic half had already detected the defect.
  const plan = visualOnlyPlan({ assertions: [{ kind: 'text', text: '这段文字绝不出现在页面上', negated: false }] });
  const judge = judgePort(JSON.stringify({ judgements: [{ id: 'B01', verdict: 'passed', citation: '我看到测试书名' }] }));
  const { outcome } = await runVisual(plan, judge);
  expect(outcome.kind).toBe('scripted');
  if (outcome.kind !== 'scripted') return;
  expect(outcome.result.result.items[0]).toMatchObject({ behaviorId: 'B01', verdict: 'failed' });
});

// A budget that runs out and a run stopped on purpose arrive as the same aborted signal, and their correct
// behaviours are opposites. These two tests pin both: the first keeps forty-two programmes' worth of work
// instead of discarding it, the second refuses to write a verdict for a run that was cancelled.
function twoBehaviourPlan(): Plan {
  const first = fixturePlan().behaviors[0]!;
  return { ...fixturePlan(), behaviors: [first, { ...first, id: 'B02', title: '第二条' }] };
}

test('a budget that runs out keeps the verdicts already reached and blocks only what it did not run', async () => {
  const fixture = formFixture(SESSION);
  const plan = twoBehaviourPlan();
  const controller = new AbortController();
  const result = await runPrograms(compilePlan(plan), { browser: fixture.browser, behaviors: plan.behaviors,
    signal: controller.signal, saveScreenshot: screenshotSink({ ownerId: PROJECT, projectId: PROJECT, revisionId: REVISION }).save,
    onProgress: async () => { controller.abort('REVIEW_TIMEOUT'); } });
  // The first behaviour was really executed, so its verdict survives the budget running out.
  expect(result.items.get('B01')!.verdict).not.toBe('blocked');
  // The second never ran, so it is blocked, and the verdict says why rather than staying silent.
  expect(result.items.get('B02')!.verdict).toBe('blocked');
  expect(result.items.get('B02')!.actual).toContain('预算');
});

test('an abort that is not the budget still raises, so a cancelled run writes no verdict', async () => {
  const fixture = formFixture(SESSION);
  const plan = twoBehaviourPlan();
  const controller = new AbortController();
  await expect(runPrograms(compilePlan(plan), { browser: fixture.browser, behaviors: plan.behaviors,
    signal: controller.signal, saveScreenshot: screenshotSink({ ownerId: PROJECT, projectId: PROJECT, revisionId: REVISION }).save,
    onProgress: async () => { controller.abort(); } })).rejects.toThrow();
});

test('visual capture retains browser capabilities needed by a scoped program', async () => {
  const fixture = formFixture(SESSION);
  const captures = await captureVisualPrograms({
    behaviors: [{ ...visualOnlyPlan().behaviors[0], initialState: 'fresh',
      assertions: [{ kind: 'target-text', target: { role: 'status', name: '总额' }, text: '12.00', match: 'exact', negated: false }] }],
    browser: { ...fixture.browser, reset: fixture.browser.open,
      inspect: async () => ({ observation: await fixture.browser.observe(), matches: [{ text: '12.00', value: null }] }) },
    signal: new AbortController().signal,
    saveScreenshot: screenshotSink({ ownerId: PROJECT, projectId: PROJECT, revisionId: REVISION }).save,
  });
  expect(captures.get('B01')?.item.verdict).toBe('passed');
  expect(captures.get('B01')?.images).toHaveLength(1);
});

test.each(['text', 'visual'] as const)('a %s program exceeding shared evidence capacity keeps earlier verified items', async (evidence) => {
  const plan = twoBehaviourPlan();
  plan.behaviors[1].steps = [{ type: 'open', path: '/' },
    ...Array.from({ length: 63 }, () => ({ type: 'press' as const, key: '1' as const }))];
  plan.behaviors[1].assertions = [{ kind: 'text', text: 'x', negated: false }];
  plan.behaviors.push({ ...plan.behaviors[1], id: 'B03', evidence });
  const large = 'x'.repeat(31_000);
  const fixture = formFixture(SESSION, { after: Object.fromEntries(
    Array.from({ length: 130 }, (_, i) => [i + 1, i === 0 ? { text: '测试书名' } : { text: large, tree: large }])) });
  const value=binding(randomUUID());
  const outcome = await runScriptedPlan({ browser: fixture.browser, binding:value, handoff:handoffFor(plan,value),
    signal: new AbortController().signal, saveScreenshot: screenshotSink({ ownerId: PROJECT, projectId: PROJECT, revisionId: REVISION }).save,
    visualJudge:{request:async()=>JSON.stringify({judgements:[{id:'B03',verdict:'passed',citation:'x'}]})} });
  expect(outcome.kind).toBe('scripted');
  if(outcome.kind!=='scripted')return;
  expect(outcome.result.result.items[0].verdict).toBe('passed');
  expect(outcome.result.result.items[1].verdict).toBe('passed');
  expect(outcome.result.result.items[2]).toMatchObject({ verdict: 'blocked', actual: expect.stringContaining('REVIEW_EVIDENCE_TOO_LARGE') });
  expect(outcome.result.evidence.every(event => event.behaviorId !== 'B03')).toBe(true);
});
