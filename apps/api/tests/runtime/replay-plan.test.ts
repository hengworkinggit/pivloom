import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { HandoffSchema, ReviewBindingSchema, type Handoff, type Plan } from '@pivloom/contracts';
import { compilePlan, runPrograms, runScriptedPlan, type ReplayUncompilable } from '../../src/runtime/replay-plan.js';
import { assertReviewerResult } from '../../src/runtime/reviewer.js';
import type { ProbeEvent } from '../../src/runtime/types.js';
import type { StoredArtifact } from '../../src/storage/artifacts.js';
import { createMeaningfulProgressGate } from '../../src/generation/progress-watchdog.js';
import { parseReviewEvidence } from '../../src/data/generation.js';
import { formFixture, PNG_SHA256 } from './replay-fixture.js';

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

test('a behaviour without steps is uncompilable and stays on the model path', async () => {
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

test('a partially compilable plan falls back for the whole report and says which behaviour and why', async () => {
  const compiledPlan = fixturePlan();
  const plan: Plan = { ...compiledPlan, behaviors: [compiledPlan.behaviors[0],
    { ...compiledPlan.behaviors[0], id: 'B02', title: '拖拽排序', steps: undefined, assertions: undefined }] };
  const value = binding(randomUUID());
  const fixture = formFixture(SESSION, { after: { 1: { text: '测试书名' } } });
  const outcome = await runScriptedPlan({ binding: value, handoff: handoffFor(plan, value), browser: fixture.browser,
    signal: new AbortController().signal, saveScreenshot: screenshotSink({ ownerId: PROJECT, projectId: PROJECT, revisionId: REVISION }).save });
  expect(outcome.kind).toBe('fallback');
  if (outcome.kind !== 'fallback') return;
  expect(outcome.compiled).toEqual(['B01']);
  expect(outcome.uncompilable).toEqual([{ behaviorId: 'B02', reason: 'missing-steps' }]);
  // The compiled behaviour really ran, so its progress events stand; the report
  // itself is not submitted because it could not cover B02.
  expect(fixture.calls.open).toBe(1);
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

test('a stale control during the scripted pass is reported as STALE_BROWSER_REF, not a blocked candidate', async () => {
  const plan = fixturePlan({ steps: [{ type: 'open', path: '/' }, { type: 'click', role: 'button', name: '不存在' }] });
  const value = binding(randomUUID());
  const fixture = formFixture(SESSION);
  await expect(runScriptedPlan({ binding: value, handoff: handoffFor(plan, value), browser: fixture.browser,
    signal: new AbortController().signal, saveScreenshot: screenshotSink({ ownerId: PROJECT, projectId: PROJECT, revisionId: REVISION }).save }))
    .rejects.toMatchObject({ code: 'STALE_BROWSER_REF' });
  // No completion event: the run is failing, and reporting progress for a program
  // that never finished would keep a dead run alive.
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
