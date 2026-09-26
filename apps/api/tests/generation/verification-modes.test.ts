import { expect, test } from 'vitest';
import { PlanSchema, preservesPreviousBehavior } from '@pivloom/contracts';

const prose = {
  schemaVersion: 1, goal: 'Inspect an interactive canvas', changeSummary: 'Draw and manipulate a shape', assumptions: [], outOfScope: [],
  behaviors: [{ id: 'B01', title: 'Move the shape', precondition: 'Canvas is visible', action: 'Observe the shape and move it',
    expected: 'The shape visibly moves in the chosen direction', required: true }],
};

test('interactive verification explicitly carries a complete prose contract without a guessed program', () => {
  const value = PlanSchema.safeParse({ ...prose, verificationMode: 'interactive' });
  expect(value.success).toBe(true);
  if (!value.success) return;
  expect(value.data.behaviors[0].expected).toBe(prose.behaviors[0].expected);
  expect(value.data.behaviors[0].required).toBe(true);
  expect(value.data.behaviors[0].steps).toBeUndefined();
  // Historical reading compatibility does not decide new submission admission.
  expect(PlanSchema.safeParse(prose).success).toBe(true);
});

test('interactive verification cannot mix in program fields, including empty placeholder arrays', () => {
  for (const fields of [{ steps: [] }, { assertions: [] }, { initialState: 'fresh' }, { steps: [{ type: 'open' }] }])
    expect(PlanSchema.safeParse({ ...prose, verificationMode: 'interactive',
      behaviors: [{ ...prose.behaviors[0], ...fields }] }).success).toBe(false);
});

test('switching to interactive cannot drop an inherited deterministic program even if its behavior was optional', () => {
  const previous = PlanSchema.parse({ ...prose, verificationMode: 'programs',
    behaviors: [{ ...prose.behaviors[0], required: false, initialState: 'fresh', steps: [{ type: 'open' }],
      assertions: [{ kind: 'control', role: 'button', name: 'Start' }] }] });
  const next = PlanSchema.parse({ ...prose, verificationMode: 'interactive',
    behaviors: [{ ...prose.behaviors[0], id: 'B02' }] });
  expect(preservesPreviousBehavior(next, previous, 'Add a new view')).toBe(false);
});
