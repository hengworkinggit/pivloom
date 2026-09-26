import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { BehaviorAssertionSchema, BehaviorStepSchema, type BehaviorTargetLocator } from '@pivloom/contracts';
import { runReplayProgram } from '../../src/runtime/replay.js';
import type { BrowserKeyBatch } from '../../src/runtime/browser.js';
import { formFixture } from './replay-fixture.js';

const sessionId = 'pivloom-11111111-2222-4333-8444-555555555555';
const saveScreenshot = async (image: { base64: string; mimeType: 'image/png'; sha256: string }) =>
  ({ ...image, id: randomUUID(), key: `fixture/${image.sha256}`, bytes: 68 });

test('clearing a field passes with historical text present, but a wrong result cannot pass from keypad text', async () => {
  const fixture = formFixture(sessionId, { initial: { text: 'Result 0 Keypad 0 1 2 History 1+2=3' } });
  let resultText = '0';
  const browser = { ...fixture.browser, async inspect(target: BehaviorTargetLocator) {
    return { observation: await fixture.browser.observe(), matches: [
      { text: target.name === 'Result' ? resultText : '', value: target.name === 'Expression' ? '' : null },
    ] };
  } };
  const input = { browser, signal: new AbortController().signal, rendersOnly: false, saveScreenshot,
    target: { expected: 'Expression is empty and Result is 0; history remains unchanged' },
    program: { behaviorId: 'B01', initialState: 'continue' as const,
      steps: [{ type: 'open' }, { type: 'press', key: 'Escape' }].map(step => BehaviorStepSchema.parse(step)),
      assertions: [
        { kind: 'target-value', target: { role: 'textbox', name: 'Expression' }, value: '' },
        { kind: 'target-text', target: { role: 'status', name: 'Result' }, text: '0', match: 'exact' },
      ].map(value => BehaviorAssertionSchema.parse(value)) } };
  expect((await runReplayProgram(input)).item.verdict).toBe('passed');
  resultText = '999';
  expect((await runReplayProgram(input)).item.verdict).toBe('failed');
});

test('fresh scenarios are order-independent while reload inside one scenario retains saved entries', async () => {
  const fixture = formFixture(sessionId, { after: { 1: { text: 'Saved book' } } });
  const browser = { ...fixture.browser, async reset(path?: string) {
    fixture.state.actions = 0;
    return fixture.browser.open(path);
  } };
  const run = (steps: unknown[], expected: string, rendersOnly = false) => runReplayProgram({
    browser, signal: new AbortController().signal, rendersOnly, saveScreenshot, target: { expected },
    program: { behaviorId: 'B01', initialState: 'fresh', steps: steps.map(step => BehaviorStepSchema.parse(step)),
      assertions: [BehaviorAssertionSchema.parse({ kind: 'text', text: expected })] },
  });
  const empty = () => run([{ type: 'open' }, { type: 'capture' }], '空书单', true);
  const saveThenReload = () => run([{ type: 'open' }, { type: 'click', name: '添加' }, { type: 'reload' }], 'Saved book');
  expect((await empty()).item.verdict).toBe('passed');
  expect((await saveThenReload()).item.verdict).toBe('passed');
  expect((await empty()).item.verdict).toBe('passed');
  expect((await saveThenReload()).item.verdict).toBe('passed');
});

test('all 21 computations use real keyboard events and the bounded history contains the final 20', async () => {
  const fixture = formFixture(sessionId);
  let expression = '', result = '', submitted = 0;
  const history: string[] = [];
  const browser = { ...fixture.browser, async keyBatch(input: BrowserKeyBatch) {
    for (const step of input.steps) {
      if (step.key === 'Escape') expression = '';
      else if (step.key === 'Enter') {
        const [left, right] = expression.split('+').map(Number);
        result = String(left + right); submitted++;
        history.push(`${expression}=${result}`);
        if (history.length > 20) history.shift();
      } else expression += step.key;
    }
    return { observation: await fixture.browser.observe(), startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
      steps: input.steps.map((step, index) => ({ ...step, index, success: true })) };
  }, async inspect(target: BehaviorTargetLocator) {
    return { observation: await fixture.browser.observe(), matches: target.role === 'listitem'
      ? history.map(text => ({ text, value: null })) : [{ text: result, value: null }] };
  } };
  const keys = Array.from({ length: 21 }, (_, index) => ['Escape', ...`${index + 1}+${index + 1}`, 'Enter']).flat();
  const outcome = await runReplayProgram({ browser, signal: new AbortController().signal, rendersOnly: false, saveScreenshot,
    target: { expected: '21 calculations leave the last 20 results in history' },
    program: { behaviorId: 'B01', initialState: 'continue',
      steps: [{ type: 'open' }, { type: 'key_sequence', keys }].map(step => BehaviorStepSchema.parse(step)),
      assertions: [
        { kind: 'target-count', target: { role: 'listitem', within: { role: 'list', name: 'History' } }, count: 20 },
        { kind: 'target-text', target: { role: 'status', name: 'Result' }, text: '42', match: 'exact' },
      ].map(value => BehaviorAssertionSchema.parse(value)) },
  });
  expect(outcome.item.verdict).toBe('passed');
  expect(submitted).toBe(21);
  expect(history).toHaveLength(20);
  expect(history[0]).toBe('2+2=4');
  expect(history.at(-1)).toBe('21+21=42');
});

test('missing scenario setup is rejected before the browser starts', async () => {
  const fixture = formFixture(sessionId);
  await expect(runReplayProgram({ browser: fixture.browser, signal: new AbortController().signal,
    rendersOnly: false, saveScreenshot, target: { expected: 'A saved book exists' },
    program: { behaviorId: 'B01', steps: [BehaviorStepSchema.parse({ type: 'open' })],
      assertions: [BehaviorAssertionSchema.parse({ kind: 'target-text', target: { role: 'status', name: 'Saved book' }, text: 'Saved' })] },
  })).rejects.toMatchObject({ code: 'INVALID_TEST_PROGRAM' });
  expect(fixture.calls.open).toBe(0);
});

test('a saved form outcome is checked after asynchronous UI settling within its named list', async () => {
  const fixture = formFixture(sessionId, { initial: { text: 'Navigation contains Saved. Empty queue.' } });
  let saved = false;
  let ready: ReturnType<typeof setTimeout> | undefined;
  const browser = { ...fixture.browser, async act(action: Parameters<typeof fixture.browser.act>[0]) {
    ready = setTimeout(() => { saved = true; }, 1);
    return fixture.browser.act(action);
  }, async inspect(target: BehaviorTargetLocator) {
    return { observation: await fixture.browser.observe(), matches: target.within?.name === 'Submission queue' && saved
      ? [{ text: 'Draft submitted', value: null }] : [] };
  } };
  try {
    const result = await runReplayProgram({ browser, signal: new AbortController().signal, rendersOnly: false, saveScreenshot,
      target: { expected: 'The submitted draft appears in the submission queue' },
      program: { behaviorId: 'B01', initialState: 'continue',
        steps: [{ type: 'open' }, { type: 'fill', role: 'textbox', name: '书名', text: 'Draft' },
          { type: 'wait', ms: 10 }].map(step => BehaviorStepSchema.parse(step)),
        assertions: [BehaviorAssertionSchema.parse({ kind: 'target-text',
          target: { role: 'listitem', within: { role: 'list', name: 'Submission queue' } }, text: 'Draft submitted' })] },
    });
    expect(result.item.verdict).toBe('passed');
    expect(result.item.actual).toContain('Draft submitted');
  } finally { clearTimeout(ready); }
});

test('an absent or ambiguous outcome target is a test-definition error, never a guessed value', async () => {
  const fixture = formFixture(sessionId);
  for (const matches of [[], [{ text: 'Saved', value: null }, { text: 'Saved', value: null }]]) {
    const browser = { ...fixture.browser, inspect: async () => ({ observation: await fixture.browser.observe(), matches }) };
    await expect(runReplayProgram({ browser, signal: new AbortController().signal, rendersOnly: false, saveScreenshot,
      target: { expected: 'The save status is Saved' },
      program: { behaviorId: 'B01', initialState: 'continue',
        steps: [{ type: 'open' }, { type: 'press', key: 'Enter' }].map(step => BehaviorStepSchema.parse(step)),
        assertions: [BehaviorAssertionSchema.parse({ kind: 'target-text', target: { role: 'status', name: 'Save status' }, text: 'Saved' })] },
    })).rejects.toMatchObject({ code: 'TEST_TARGET_AMBIGUOUS' });
  }
});
