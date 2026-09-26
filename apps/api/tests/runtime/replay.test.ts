import { describe, expect, test } from 'vitest';
import { BehaviorStepSchema, ReviewItemSchema, type BehaviorAssertion } from '@pivloom/contracts';
import { evaluateAssertions, runReplayProgram, replayAction, toObservationEvent, type ReplayProgram } from '../../src/runtime/replay.js';
import { RuntimeError } from '../../src/runtime/types.js';
import { parseReviewEvidence } from '../../src/data/generation.js';
import { formFixture, PNG_SHA256 } from './replay-fixture.js';

const SESSION = 'pivloom-11111111-2222-4333-8444-555555555555';
const clickAdd = BehaviorStepSchema.parse({ type: 'click', role: 'button', name: '添加' });
const open = BehaviorStepSchema.parse({ type: 'open', path: '/' });
const capture = BehaviorStepSchema.parse({ type: 'capture' });
const text = (value: string, negated = false): BehaviorAssertion => ({ kind: 'text', text: value, negated });
const control = (name: string, negated = false): BehaviorAssertion => ({ kind: 'control', role: 'button', name, negated });
const program = (steps: ReplayProgram['steps'], assertions: BehaviorAssertion[] = [text('测试书名')]): ReplayProgram =>
  ({ behaviorId: 'B01', steps, assertions });

/** The kernel returns a ReviewerResult item, so the same contract parse the save path uses can validate it. */
function parsedItem(value: unknown) {
  return ReviewItemSchema.parse(value);
}
async function run(fixture: ReturnType<typeof formFixture>, value: ReplayProgram, overrides: Partial<Parameters<typeof runReplayProgram>[0]> = {}) {
  const screenshots: Array<{ id: string; mimeType: 'image/png'; sha256: string }> = [];
  const result = await runReplayProgram({ browser: fixture.browser, program: value, target: { expected: '书名显示' },
    rendersOnly: false, signal: new AbortController().signal,
    saveScreenshot: async (image) => { const artifact = { ...image, id: crypto.randomUUID(), key: `k/${image.sha256}`, bytes: 68 };
      screenshots.push(artifact); return artifact; }, ...overrides });
  return { result, screenshots };
}

test('a compiled program drives real controls and passes without any provider request', async () => {
  // The kernel has no model client at all: nothing in its imports can reach a
  // provider, so the absence of a fetch spy here is the point, not an omission.
  const fixture = formFixture(SESSION, { after: { 1: { text: '测试书名' } } });
  const { result, screenshots } = await run(fixture, program([open, clickAdd, capture]));
  expect(result.assertionsPassed).toBe(true);
  expect(result.item).toMatchObject({ behaviorId: 'B01', verdict: 'passed', expected: '书名显示' });
  // The real observation after the click, not the one before it.
  expect(result.item.actual).toContain('测试书名');
  expect(result.item.observationEventIds).toEqual(result.observations.map((record) => record.id));
  expect(result.item.screenshotIds).toEqual(screenshots.map((artifact) => artifact.id));
  expect(result.item.screenshotIds).toHaveLength(1);
  expect(fixture.actions).toEqual([{ type: 'click', ref: 'e2', observationId: fixture.observations[0].id }]);
  expect(screenshots[0]).toMatchObject({ mimeType: 'image/png', sha256: PNG_SHA256 });
  expect(result.observations.map((record) => record.action)).toEqual([null, 'click']);
});
test('a false assertion produces a failed verdict and still reports the observation it failed on', async () => {
  const fixture = formFixture(SESSION, { after: { 1: { text: '书单仍然是空的' } } });
  const { result } = await run(fixture, program([open, clickAdd]));
  expect(result.assertionsPassed).toBe(false);
  expect(result.item.verdict).toBe('failed');
  expect(result.item.actual).toContain('未出现');
  expect(result.assertionResults).toMatchObject([{ kind: 'text', passed: false }]);
  // A failed assertion is a result about the candidate, so the evidence is kept.
  expect(result.observations).toHaveLength(2);
});

test('a missing control is the same STALE_BROWSER_REF the model-driven loop reports', async () => {
  const fixture = formFixture(SESSION);
  await expect(run(fixture, program([open, BehaviorStepSchema.parse({ type: 'click', role: 'button', name: '删除' })])))
    .rejects.toMatchObject({ code: 'STALE_BROWSER_REF' });
});

test('an ambiguous control is a STALE_BROWSER_REF, never a guess at one of the matches', async () => {
  const fixture = formFixture(SESSION, { duplicateControl: { role: 'button', name: '添加' } });
  await expect(run(fixture, program([open, clickAdd]))).rejects.toMatchObject({ code: 'STALE_BROWSER_REF' });
  expect(fixture.actions).toHaveLength(0);
});

test('an incomplete observation stops a control step instead of resolving refs from a partial tree', async () => {
  const fixture = formFixture(SESSION, { truncated: true });
  await expect(run(fixture, program([open, clickAdd]))).rejects.toMatchObject({ code: 'STALE_BROWSER_REF' });
});

test('a control step before any observation is a stale ref rather than an implicit open', async () => {
  const fixture = formFixture(SESSION);
  await expect(run(fixture, program([clickAdd]))).rejects.toMatchObject({ code: 'STALE_BROWSER_REF' });
  expect(fixture.calls.open).toBe(0);
});

test('reload returns to the path the check is currently on', async () => {
  const fixture = formFixture(SESSION, { after: { 1: { text: '测试书名' } } });
  const { result } = await run(fixture, program([open, clickAdd, BehaviorStepSchema.parse({ type: 'reload' })]));
  expect(fixture.observations.at(-1)!.url).toBe('http://127.0.0.1:4173/');
  expect(result.observations.at(-1)!.action).toBe('reload');
  expect(result.item.verdict).toBe('passed');
});

test('the persisted evidence vocabulary is what the kernel emits, and capture keeps only an artifact', async () => {
  const fixture = formFixture(SESSION, { after: { 1: { text: '测试书名' } } });
  const { result } = await run(fixture, program([open,
    BehaviorStepSchema.parse({ type: 'resize', width: 390, height: 844 }),
    clickAdd, BehaviorStepSchema.parse({ type: 'wait', ms: 5 }), capture]));
  // Round-trips through the real save-time schema: an `open`, `resize` or
  // `capture` action name here would fail the check after the browser work, and
  // a wait is an observation of the page rather than proof the behaviour acted.
  const parsed = parseReviewEvidence(result.events);
  expect(parsed.map((event) => event.action)).toEqual([null, null, 'click', null]);
  expect(parsed.every((event) => event.behaviorId === 'B01')).toBe(true);
  // Capture is a marker: it adds an artifact and never a synthetic observation.
  expect(result.events).toHaveLength(4);
  expect(result.item.screenshotIds).toHaveLength(1);
  expect(replayAction(open)).toBeNull();
  expect(replayAction(capture)).toBeNull();
  expect(replayAction(clickAdd)).toBe('click');
  expect(replayAction(BehaviorStepSchema.parse({ type: 'reload' }))).toBe('reload');
});

test('a render-only target may pass on a real observation plus a screenshot, and the same script may not otherwise', async () => {
  const fixture = formFixture(SESSION);
  const { result } = await run(fixture, program([open, capture], [text('空书单')]));
  expect(result.assertionsPassed).toBe(true);
  expect(result.item.verdict).toBe('blocked');
  expect(result.item.actual).toContain('没有真实交互动作');
  // The sealed action decides which one applies; the script cannot promote itself.
  const renderOnly = await run(fixture, program([open, capture], [text('空书单')]), { rendersOnly: true });
  expect(renderOnly.result.item.verdict).toBe('passed');
});

describe('assertion evaluation reads only what the browser layer returned', () => {
  test('text, control and console assertions evaluate against observation, refs and logs', () => {
    const results = evaluateAssertions([
      { kind: 'text', text: '测试书名', negated: false },
      { kind: 'text', text: '错误提示', negated: true },
      { kind: 'control', role: 'button', name: '添加', negated: false },
      { kind: 'control', role: 'button', name: '删除', negated: true },
      { kind: 'console-error', negated: true },
    ], { text: '空书单', observationText: '测试书名', refs: { e2: { role: 'button', name: '添加' } }, logs: { errors: [] } });
    expect(results.map((result) => result.passed)).toEqual([true, true, true, true, true]);
  });
  test('a missing text, a present-but-negated control and a console error each fail', () => {
    const results = evaluateAssertions([
      { kind: 'text', text: '不存在', negated: false },
      control('添加', true),
      { kind: 'console-error', negated: true },
    ], { text: '空书单', observationText: '空书单', refs: { e2: { role: 'button', name: '添加' } }, logs: { errors: ['boom'] } });
    expect(results.map((result) => result.passed)).toEqual([false, false, false]);
  });
  test('a positive text assertion searches the whole body text, not only the bounded excerpt', () => {
    // A long page can push a visible string past the observation window; reporting
    // that as missing would be a failed acceptance check invented by truncation.
    const results = evaluateAssertions([{ kind: 'text', text: '页脚文字', negated: false }],
      { text: '短', observationText: `${'x'.repeat(20_000)}页脚文字`, refs: {}, logs: {} });
    expect(results[0].passed).toBe(true);
  });
});

test('the observation event is exactly the reviewer evidence shape', async () => {
  const fixture = formFixture(SESSION, { after: { 1: { text: '测试书名' } } });
  const { result } = await run(fixture, program([open, clickAdd]));
  expect(toObservationEvent(result.observations[1])).toEqual({ ...result.observations[1] });
  const [event] = parseReviewEvidence([toObservationEvent(result.observations[1])]);
  expect(event).toMatchObject({ behaviorId: 'B01', action: 'click', url: 'http://127.0.0.1:4173/' });
});

test('an aborted signal stops the program before another browser action', async () => {
  const fixture = formFixture(SESSION);
  const controller = new AbortController();
  controller.abort(new RuntimeError('CANCELLED', '已停止'));
  await expect(run(fixture, program([open, clickAdd]), { signal: controller.signal })).rejects.toThrow();
  expect(fixture.calls.act).toBe(0);
});

test('an empty program is refused rather than reported as a passing behaviour', async () => {
  const fixture = formFixture(SESSION);
  await expect(run(fixture, program([]))).rejects.toMatchObject({ code: 'REPLAY_PROGRAM_EMPTY' });
});

test('the kernel item survives the same contract validation the save path applies', async () => {
  const fixture = formFixture(SESSION, { after: { 1: { text: '测试书名' } } });
  const { result } = await run(fixture, program([open, clickAdd, capture]));
  expect(parsedItem(result.item)).toEqual(result.item);
});
