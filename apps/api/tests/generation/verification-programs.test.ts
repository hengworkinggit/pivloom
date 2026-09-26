import { expect, test } from 'vitest';
import { BehaviorProgramSchema, BehaviorStepSchema, PlanSchema, preservesPreviousBehavior } from '@pivloom/contracts';

const previous = () => PlanSchema.parse({
  schemaVersion: 1, goal: 'Manage a reading list', changeSummary: 'Add and remove books', assumptions: [], outOfScope: [],
  behaviors: [{ id: 'B01', title: 'Remove the selected book', precondition: 'A book was added',
    action: 'Remove the selected book', expected: 'The selected book is absent from the list', required: true,
    steps: [{ type: 'open', path: '/' }, { type: 'click', role: 'button', name: 'Remove book' }],
    assertions: [{ kind: 'text', text: 'Selected book', negated: true }] }],
});

test('an increment cannot invert an existing executable assertion while preserving its prose', () => {
  const before = previous();
  const after = structuredClone(before);
  after.behaviors[0].assertions![0].negated = false;
  expect(preservesPreviousBehavior(after, before, 'Add a filter')).toBe(false);
});

test('a scenario can assert an empty field and a specific list without searching the whole page', () => {
  const value = previous();
  const parsed = PlanSchema.safeParse({ ...value, behaviors: [{ ...value.behaviors[0], initialState: 'fresh',
    assertions: [
      { kind: 'target-value', target: { role: 'textbox', name: 'Book title' }, value: '', negated: false },
      { kind: 'target-text', target: { role: 'status', name: 'Save result' }, text: 'Saved', match: 'exact', negated: false },
      { kind: 'target-count', target: { role: 'listitem', within: { role: 'list', name: 'Books' } }, count: 2, negated: false },
    ] }] });
  expect(parsed.success).toBe(true);
});

test('a bounded program represents all 21 real input sequences instead of truncating the requirement', () => {
  const keys = Array.from({ length: 21 }, (_, index) => ['Escape', ...`${index + 1}+${index + 1}`, 'Enter']).flat();
  const parsed = BehaviorStepSchema.safeParse({ type: 'key_sequence', keys });
  expect(parsed.success).toBe(true);
  expect(BehaviorStepSchema.safeParse({ type: 'key_sequence', keys: ['Enter'], repeat: 513 }).success).toBe(false);
  expect(BehaviorStepSchema.safeParse({ type: 'key_sequence', keys: Array(513).fill('Enter') }).success).toBe(false);
  expect(BehaviorStepSchema.safeParse({ type: 'key_sequence', keys: ['Enter', 'F5'] }).success).toBe(false);
});

test('legacy prose may gain executable fields while established scope, input and state remain stable', () => {
  const legacy = previous();
  delete legacy.behaviors[0].steps;
  delete legacy.behaviors[0].assertions;
  const complete = PlanSchema.parse({ ...legacy, behaviors: [{ ...legacy.behaviors[0], initialState: 'fresh',
    steps: [{ type: 'open', path: '/' }, { type: 'click', role: 'button', name: 'Remove book' }],
    assertions: [{ kind: 'target-count', target: { role: 'listitem', within: { role: 'list', name: 'Books' } }, count: 0 }],
  }] });
  expect(preservesPreviousBehavior(complete, legacy)).toBe(true);
  for (const changed of [
    { initialState: 'continue' },
    { steps: [{ type: 'open', path: '/' }] },
    { assertions: [{ kind: 'target-count', target: { role: 'listitem', within: { role: 'list', name: 'Archived books' } }, count: 0 }] },
    { assertions: [{ kind: 'target-count', target: { role: 'listitem', within: { role: 'list', name: 'Books' } }, count: 1 }] },
  ]) {
    const candidate = PlanSchema.parse({ ...complete, behaviors: [{ ...complete.behaviors[0], ...changed }] });
    expect(preservesPreviousBehavior(candidate, complete), JSON.stringify(changed)).toBe(false);
  }
});

test('program admission bounds combined input and refuses external navigation before execution', () => {
  const base = { initialState: 'fresh', steps: [{ type: 'open', path: '/' }],
    assertions: [{ kind: 'target-count', target: { role: 'listitem' }, count: 0 }] };
  expect(BehaviorProgramSchema.safeParse(base).success).toBe(true);
  for (const path of ['https://example.com', '//example.com', '/\\example.com'])
    expect(BehaviorProgramSchema.safeParse({ ...base, steps: [{ type: 'open', path }] }).success).toBe(false);
  expect(BehaviorProgramSchema.safeParse({ ...base, steps: [...base.steps,
    { type: 'key_sequence', keys: Array(300).fill('Enter') }, { type: 'key_sequence', keys: Array(300).fill('Enter') },
  ] }).success).toBe(false);
});
