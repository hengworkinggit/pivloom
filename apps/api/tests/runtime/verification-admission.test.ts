import { expect, test } from 'vitest';
import { PlanSchema } from '@pivloom/contracts';
import { admitVerification } from '../../src/runtime/verification-admission.js';

const behavior = (id: string, program: Record<string, unknown> = {}) => ({
  id, title: `Scenario ${id}`, precondition: 'The form is available', action: 'Submit a record',
  expected: 'The record is saved in the requested list', required: true, ...program,
});
const plan = (behaviors: Array<ReturnType<typeof behavior>>) => PlanSchema.parse({
  schemaVersion: 1, goal: 'Manage records', changeSummary: 'Add a record', assumptions: [], outOfScope: [], behaviors,
});

test('admission reports concrete plan work separately from unknown model and browser time', () => {
  const value = plan([
    behavior('B01', { initialState: 'fresh', steps: [{ type: 'open' }, { type: 'fill', role: 'textbox', name: 'Name', text: 'Entry' },
      { type: 'key_sequence', keys: ['Enter'], repeat: 21 }, { type: 'wait', ms: 150 }, { type: 'capture' }],
      assertions: [{ kind: 'target-count', target: { role: 'listitem', within: { role: 'list', name: 'Entries' } }, count: 1 },
        { kind: 'target-value', target: { role: 'textbox', name: 'Name' }, value: '' }] }),
    behavior('B02', { initialState: 'fresh', evidence: 'visual', steps: [{ type: 'open' },
      { type: 'resize', width: 390, height: 844 }, { type: 'capture' }], assertions: [{ kind: 'console-error', negated: true }] }),
    behavior('B03'),
  ]);
  const admission = admitVerification(value, { remainingMs: 60_000 });
  expect(admission.stats).toMatchObject({ behaviors: 3, requiredBehaviors: 3, steps: 8, expandedKeys: 21,
    explicitWaitMs: 150, missingPrograms: 1, missingInitialState: 1, targetAssertions: 2, visualBehaviors: 1 });
  expect(admission.timing).toEqual({ explicitWaitMs: 150, remainingMs: 60_000, unmeasuredMs: null, completionGuarantee: false });
  expect(JSON.parse(JSON.stringify(admission))).toEqual(admission);
});

test('invalid programs keep their required accounting and reasons while readable legacy setup is explicit', () => {
  const scoped = { steps: [{ type: 'open' }, { type: 'press', key: 'Enter' }],
    assertions: [{ kind: 'target-text', target: { role: 'status', name: 'Save status' }, text: 'Saved' }] };
  const admission = admitVerification(plan([
    behavior('B01', { ...scoped, initialState: 'fresh' }),
    behavior('B02', scoped),
    behavior('B03', { ...scoped, initialState: 'fresh', steps: [{ type: 'press', key: 'Enter' }] }),
    behavior('B04'),
    behavior('B05', { steps: [{ type: 'open' }], assertions: [{ kind: 'text', text: 'Welcome' }] }),
  ]), { remainingMs: 60_000 });
  expect(admission.decision).toBe('partial');
  expect(admission.programs).toMatchObject([
    { behaviorId: 'B01', required: true, disposition: 'READY', legacyInitialState: false },
    { behaviorId: 'B02', required: true, disposition: 'NOT_RUN', failureKind: 'invalid-test' },
    { behaviorId: 'B03', required: true, disposition: 'NOT_RUN', failureKind: 'invalid-test' },
    { behaviorId: 'B04', required: true, disposition: 'NOT_RUN', failureKind: 'invalid-test' },
    { behaviorId: 'B05', required: true, disposition: 'READY', legacyInitialState: true },
  ]);
  expect(admission.invalidPrograms).toMatchObject([
    { behaviorId: 'B02', reason: 'missing-initial-state', issues: [{ path: 'initialState' }] },
    { behaviorId: 'B03', reason: 'invalid-program', issues: [{ path: 'steps.0' }] },
    { behaviorId: 'B04', reason: 'missing-program' },
  ]);
  expect(admission.stats.requiredBehaviors).toBe(5);
  expect(admission.stats.legacyPageTextAssertions).toBe(1);
});

test.each([
  [{ remainingMs: 60_000, maxSteps: 2 }, 'steps', 3, 2],
  [{ remainingMs: 60_000, maxExpandedKeys: 20 }, 'expandedKeys', 21, 20],
  [{ remainingMs: 60_000, maxExplicitWaitMs: 500 }, 'explicitWaitMs', 1000, 500],
  [{ remainingMs: 500 }, 'remainingMs', 1000, 500],
])('an exceeded declared budget leaves the entire plan NOT_RUN with concrete numbers (%j)', (budget, resource, required, limit) => {
  const value = plan([behavior('B01', { initialState: 'fresh', steps: [{ type: 'open' },
    { type: 'key_sequence', keys: ['Enter'], repeat: 21 }, { type: 'wait', ms: 1000 }],
    assertions: [{ kind: 'target-text', target: { role: 'status', name: 'Result' }, text: 'Saved' }] })]);
  const admission = admitVerification(value, budget);
  expect(admission.decision).toBe('not-run');
  expect(admission.programs).toMatchObject([{ behaviorId: 'B01', required: true, disposition: 'NOT_RUN', failureKind: 'not-run', reason: 'capacity-exceeded' }]);
  expect(admission.budgetExceeded).toContainEqual({ resource, required, limit, reason: 'exceeded' });
  expect(admission.invalidPrograms).toEqual([]);
  expect(value.behaviors).toHaveLength(1);
});

test('an exhausted deadline never admits work merely because explicit waits are zero', () => {
  const value = plan([behavior('B01', { initialState: 'fresh', steps: [{ type: 'open' }, { type: 'press', key: 'Enter' }],
    assertions: [{ kind: 'target-text', target: { role: 'status', name: 'Result' }, text: 'Saved' }] })]);
  const admission = admitVerification(value, { remainingMs: 0 });
  expect(admission.decision).toBe('not-run');
  expect(admission.budgetExceeded).toContainEqual({ resource: 'remainingMs', required: 0, limit: 0, reason: 'exhausted' });
  expect(admission.timing.completionGuarantee).toBe(false);
});

test('the public program schema rejects combined input beyond its execution limit even with generous run limits', () => {
  const admission = admitVerification(plan([behavior('B01', { initialState: 'fresh', steps: [{ type: 'open' },
    { type: 'key_sequence', keys: ['Enter'], repeat: 300 }, { type: 'key_sequence', keys: ['Enter'], repeat: 300 }],
    assertions: [{ kind: 'target-count', target: { role: 'listitem' }, count: 20 }] })]),
  { remainingMs: 60_000, maxExpandedKeys: 1000 });
  expect(admission.decision).toBe('not-run');
  expect(admission.invalidPrograms).toMatchObject([{ behaviorId: 'B01', reason: 'invalid-program',
    issues: [{ path: 'steps', message: '整个场景展开后不得超过 512 个真实按键。' }] }]);
  expect(admission.budgetExceeded).toEqual([]);
  expect(admission.programs[0].failureKind).toBe('invalid-test');
});

test('Canvas appearance remains a visual requirement even when its DOM score assertion is structurally valid', () => {
  const admission = admitVerification(plan([behavior('B01', { initialState: 'fresh', evidence: 'visual',
    steps: [{ type: 'open' }, { type: 'press', key: 'ArrowRight' }, { type: 'capture' }],
    assertions: [{ kind: 'target-text', target: { role: 'status', name: 'Score' }, text: '1' }] })]), { remainingMs: 60_000 });
  expect(admission.decision).toBe('ready');
  expect(admission.stats.visualBehaviors).toBe(1);
  expect(admission.stats.targetAssertions).toBe(1);
  expect(admission.programs[0].disposition).toBe('READY');
  expect(admission.timing.completionGuarantee).toBe(false);
});

test('non-finite or negative resource limits cannot masquerade as serializable admission results', () => {
  const value = plan([behavior('B01')]);
  expect(() => admitVerification(value, { remainingMs: Infinity })).toThrow(RangeError);
  expect(() => admitVerification(value, { remainingMs: 1000, maxExpandedKeys: NaN })).toThrow(RangeError);
  expect(() => admitVerification(value, { remainingMs: 1000, maxSteps: -1 })).toThrow(RangeError);
  expect(admitVerification(value, { remainingMs: -10 }).timing.remainingMs).toBe(0);
});
