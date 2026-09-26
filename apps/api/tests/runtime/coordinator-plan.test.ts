import { expect, test } from 'vitest';
import { GroupedPlanSchema, type PlanningContext } from '@pivloom/contracts';
import { CoordinatorIncrementSchema, composeCoordinatorIncrement, coordinatorProjectSummary } from '../../src/runtime/coordinator-plan.js';

const requirement = { title: 'Add a record', precondition: 'The list is open', action: 'Submit a new record', expected: 'The list contains it' };
function baseline(count = 5) {
  const behaviors = Array.from({ length: count }, (_, i) => ({ ...requirement, id: `B${String(i + 1).padStart(2, '0')}`,
    title: `Original ${i + 1}`, expected: `Original outcome ${i + 1}`, required: true }));
  return GroupedPlanSchema.parse({ schemaVersion: 2, goal: 'Manage records', changeSummary: 'Initial requirements',
    assumptions: ['Local data'], outOfScope: ['Cloud sync'], replacements: [], behaviors,
    groups: Array.from({ length: 5 }, (_, i) => ({ id: `G${i + 1}`, title: `Original group ${i + 1}`,
      behaviorIds: behaviors.filter((_, index) => index % 5 === i).map(behavior => behavior.id) })),
  });
}

test('composition preserves old requirements and programs, and the delta cannot supply their executable fields', () => {
  const previous = baseline();
  previous.behaviors[0] = { ...previous.behaviors[0], initialState: 'fresh', steps: [{ type: 'open', path: '/' }, { type: 'press', key: 'Enter' }],
    assertions: [{ kind: 'target-text', target: { role: 'status', name: 'Original result' }, text: 'Original outcome 1', match: 'exact', negated: false }] };
  const input = CoordinatorIncrementSchema.parse({ changeSummary: 'Add a record', additions: [{ groupId: 'G4', requirement }] });
  const next = composeCoordinatorIncrement(input, previous, 'Add a record');
  expect(next.behaviors.slice(0, 5)).toEqual(previous.behaviors);
  expect(next.groups.map(group => [group.id, group.title])).toEqual(previous.groups.map(group => [group.id, group.title]));
  expect(next.assumptions).toEqual(previous.assumptions);
  expect(next.behaviors[5]).toEqual({ ...requirement, id: 'B06', required: true });
  expect(CoordinatorIncrementSchema.safeParse({ ...input, additions: [{ groupId: 'G4', requirement: { ...requirement, steps: [] } }] }).success).toBe(false);
  expect(() => composeCoordinatorIncrement({ ...input, verificationMode: 'interactive' }, previous, 'Add a record')).toThrow();
  next.behaviors[0].expected = 'Mutated output object';
  expect(previous.behaviors[0].expected).toBe('Original outcome 1');
});

test('an explicit replacement stays in its old group and cannot change the required flag or lack user authorization', () => {
  const previous = baseline();
  const input = CoordinatorIncrementSchema.parse({ changeSummary: 'Change result format', replacements: [{ oldBehaviorId: 'B02',
    requirement: { ...requirement, expected: 'Two decimals' }, userRequestQuote: '把结果改为两位小数', reason: 'Requested format change' }] });
  const next = composeCoordinatorIncrement(input, previous, '请把结果改为两位小数');
  expect(next.behaviors[1]).toMatchObject({ id: 'B06', required: true, expected: 'Two decimals' });
  expect(next.groups[1].behaviorIds).toEqual(['B06']);
  expect(next.replacements).toEqual([{ oldBehaviorId: 'B02', newBehaviorId: 'B06', userRequestQuote: '把结果改为两位小数', reason: 'Requested format change' }]);
  expect(() => composeCoordinatorIncrement(input, previous, 'Add a search field')).toThrow();
  const weaker = CoordinatorIncrementSchema.parse({ ...input, replacements: [{ ...input.replacements[0],
    requirement: { ...input.replacements[0].requirement, required: false } }] });
  expect(() => composeCoordinatorIncrement(weaker, previous, '请把结果改为两位小数')).toThrow();
});

test('retired IDs and historical replacement records survive an ordinary addition', () => {
  const previous = baseline();
  previous.replacements = [{ oldBehaviorId: 'B06', newBehaviorId: 'B01', userRequestQuote: '替换旧入口', reason: 'Historical change' }];
  const next = composeCoordinatorIncrement(CoordinatorIncrementSchema.parse({ changeSummary: 'Add a record',
    additions: [{ groupId: 'G4', requirement }] }), previous, 'Add a record');
  expect(next.behaviors.at(-1)?.id).toBe('B07');
  expect(next.replacements).toEqual(previous.replacements);
});

test('a requirement-preserving implementation fix can reuse the entire plan without adding duplicate checks', () => {
  const previous = baseline();
  const next = composeCoordinatorIncrement(CoordinatorIncrementSchema.parse({ changeSummary: 'Fix the existing save action' }), previous, 'Fix save');
  expect(next.behaviors).toEqual(previous.behaviors);
  expect(next.groups).toEqual(previous.groups);
  expect(() => composeCoordinatorIncrement(CoordinatorIncrementSchema.parse({ changeSummary: 'No base' }), null, 'Create')).toThrow('previous five-group plan');
});

test('capacity rejection cannot truncate old requirements to make an increment fit', () => {
  const previous = baseline(80);
  expect(() => composeCoordinatorIncrement(CoordinatorIncrementSchema.parse({ changeSummary: 'Add a record',
    additions: [{ groupId: 'G4', requirement }] }), previous, 'Add a record')).toThrow();
  expect(previous.behaviors).toHaveLength(80);
});

test('project summary exposes canonical prose and saved-program presence without repeating the program body', () => {
  const previous = baseline();
  previous.behaviors[0] = { ...previous.behaviors[0], initialState: 'fresh', steps: [{ type: 'open', path: '/' }],
    assertions: [{ kind: 'target-text', target: { role: 'status', name: 'Private program selector' }, text: 'Original outcome 1', match: 'exact', negated: false }] };
  const context: PlanningContext = { schemaVersion: 1, project: { id: '11111111-1111-4111-8111-111111111111', title: 'Records' },
    requestText: 'Add a record', originalRequest: 'Manage records', clarificationTurns: [], baseRevisionId: null, previousPlan: previous };
  const summary = coordinatorProjectSummary(context);
  expect(summary.canSubmitIncrement).toBe(true);
  expect(summary.sealedProgramBehaviorIds).toEqual(['B01']);
  expect(summary.previousPlan?.behaviors[0]).toEqual({ id: 'B01', title: 'Original 1', precondition: requirement.precondition,
    action: requirement.action, expected: 'Original outcome 1', required: true });
  expect(JSON.stringify(summary)).not.toContain('Private program selector');
});
