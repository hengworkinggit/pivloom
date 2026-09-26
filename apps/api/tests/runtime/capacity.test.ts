import { expect, test } from 'vitest';
import {
  MAX_CHECK_ARTIFACTS, GroupedPlanSchema, BehaviorTargetSchema, type BehaviorTarget,
} from '@pivloom/contracts';
import {
  REVIEW_EVIDENCE_ENTRY_LIMIT, REVIEW_EVIDENCE_LIMIT_BYTES, REVIEW_TOOL_CALLS_PER_BEHAVIOR,
  REVIEW_TOOL_LIMIT, REVIEW_TOOL_LIMIT_CEILING, RUN_TOOL_LIMIT,
} from '../../src/runtime/budgets.js';
import {
  ASSUMED_ASSERTIONS_PER_BEHAVIOR, ASSUMED_STEPS_PER_BEHAVIOR, BEHAVIOR_ARRAY_SKELETON_BYTES,
  BEHAVIOR_ASSERTION_BYTES, BEHAVIOR_CROSS_FIELD_PUNCTUATION_BYTES, BEHAVIOR_EVIDENCE_FLAG_BYTES,
  BEHAVIOR_PLAN_BYTES, BEHAVIOR_PROSE_BYTES, BEHAVIOR_STEP_BYTES, CAPACITY_ENFORCEMENT, CAPACITY_HEADROOM,
  HANDOFF_BYTE_LIMIT, MAXIMAL_PROSE_BEHAVIOR_BYTES, MAX_PLAN_BEHAVIORS, MEASURED_EVIDENCE_BYTES_PER_BEHAVIOR,
  MEASURED_EVIDENCE_ENTRIES_PER_BEHAVIOR, MEASURED_TOOL_CALLS_PER_BEHAVIOR, PLAN_BYTE_LIMIT, PLAN_SCAFFOLD_BYTES,
  currentLimits, envelope, limits, planByteBudgetPerBehavior, preflightCapacity, required,
} from '../../src/runtime/capacity.js';
import { RuntimeError } from '../../src/runtime/types.js';

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

// The repository's own contract fixtures, so every byte constant in capacity.ts
// is re-measured from the same shapes the schema tests use.
const prose = (id: string): BehaviorTarget => ({
  id, title: `行为 ${id}`, precondition: '页面已打开', action: `执行 ${id}`, expected: `观察 ${id}`, required: true,
});
const steps = [{ type: 'open' as const }, { type: 'reload' as const }, { type: 'resize' as const, width: 390, height: 844 },
  { type: 'click' as const, name: '添加' }, { type: 'fill' as const, name: '书名', text: '三体' },
  { type: 'select' as const, name: '分类', value: '科幻' }, { type: 'press' as const, key: 'Enter' as const },
  { type: 'wait' as const, ms: 200 }, { type: 'capture' as const }];
const assertions = [{ kind: 'text' as const, text: '已添加', negated: false }, { kind: 'text' as const, text: '错误', negated: true },
  { kind: 'control' as const, role: 'button', name: '添加', negated: false }, { kind: 'control' as const, role: 'button', name: '清空', negated: true },
  { kind: 'console-error' as const, negated: true }];
const compiled = (id: string) => BehaviorTargetSchema.parse({ ...prose(id), steps, assertions, evidence: 'visual' });

function fixturePlan(count: number) {
  const behaviours = Array.from({ length: count }, (_, index) => compiled(`B${String(index + 1).padStart(2, '0')}`));
  const chunk = Math.ceil(count / 5);
  return GroupedPlanSchema.parse({
    schemaVersion: 2, goal: '计算器', changeSummary: '首版完整验收', assumptions: [], outOfScope: [], behaviors: behaviours,
    groups: [
      { id: 'G1', title: '数值运算', behaviorIds: behaviours.slice(0, chunk).map((item) => item.id) },
      { id: 'G2', title: '输入与键盘', behaviorIds: behaviours.slice(chunk, 2 * chunk).map((item) => item.id) },
      { id: 'G3', title: '错误恢复', behaviorIds: behaviours.slice(2 * chunk, 3 * chunk).map((item) => item.id) },
      { id: 'G4', title: '结果与状态', behaviorIds: behaviours.slice(3 * chunk, 4 * chunk).map((item) => item.id) },
      { id: 'G5', title: '视觉布局', behaviorIds: behaviours.slice(4 * chunk, 5 * chunk).map((item) => item.id) },
    ], replacements: [],
  });
}

test('the headroom is the per-behaviour allowance the code already applies, not a chosen number', () => {
  // budgets.ts:47-49 records the measurement; budgets.ts:51 is the allowance.
  expect(MEASURED_TOOL_CALLS_PER_BEHAVIOR * 45).toBe(240);
  expect(CAPACITY_HEADROOM).toBe(1.5);
  expect(MEASURED_TOOL_CALLS_PER_BEHAVIOR * CAPACITY_HEADROOM).toBe(REVIEW_TOOL_CALLS_PER_BEHAVIOR);
  // budgets.ts:57-60: 480 KiB was roughly twenty observations.
  expect(MEASURED_EVIDENCE_BYTES_PER_BEHAVIOR * 20).toBe(480 * 1024);
  // spec review-capacity...:25: a forty-two behaviour check exceeded 256 entries.
  expect(MEASURED_EVIDENCE_ENTRIES_PER_BEHAVIOR).toBe(7);
  expect(MEASURED_EVIDENCE_ENTRIES_PER_BEHAVIOR * 42).toBeGreaterThan(256);
});

test('the measured envelope for the recorded plan sizes carries the code evidence, not invented numbers', () => {
  // 5 and 14 behaviours are the production plan sizes; 41 and 45 are C3's.
  expect(envelope(5)).toMatchObject({ behaviours: 5, reviewToolCalls: 27, runToolCalls: 103, evidenceEntries: 35,
    evidenceBytes: 5 * 24 * 1024, artifacts: 5, planBytes: 4382 });
  expect(envelope(14)).toMatchObject({ reviewToolCalls: 75, runToolCalls: 151, evidenceEntries: 98,
    evidenceBytes: 14 * 24 * 1024, artifacts: 14, planBytes: 11528 });
  expect(envelope(41)).toMatchObject({ reviewToolCalls: 219, runToolCalls: 295, evidenceEntries: 287,
    evidenceBytes: 41 * 24 * 1024, artifacts: 41, planBytes: 32966 });
  expect(envelope(45)).toMatchObject({ reviewToolCalls: 240, runToolCalls: 316, evidenceEntries: 315,
    evidenceBytes: 45 * 24 * 1024, artifacts: 45, planBytes: 36142 });
  // The envelope reproduces the Reviewer's own scaling exactly, because the
  // headroom is derived from REVIEW_TOOL_CALLS_PER_BEHAVIOR.
  for (const count of [5, 14, 41, 45]) {
    expect(required(count).reviewToolCalls).toBe(count * REVIEW_TOOL_CALLS_PER_BEHAVIOR + 3);
    expect(currentLimits(count).reviewToolCalls).toBe(Math.max(REVIEW_TOOL_LIMIT,
      Math.min(count * REVIEW_TOOL_CALLS_PER_BEHAVIOR, REVIEW_TOOL_LIMIT_CEILING)));
  }
  // recon doc:74 pins 41 behaviours to maxTools=328 in today's code.
  expect(currentLimits(41).reviewToolCalls).toBe(328);
  expect(currentLimits(45).reviewToolCalls).toBe(360);
});

test('the pre-flight reports which of today’s constants 5, 14, 41 and 45 behaviours would exceed', () => {
  expect(preflightCapacity(5)).toMatchObject({ verdict: 'ok', enforced: false });
  expect(preflightCapacity(14)).toMatchObject({ verdict: 'ok', enforced: false });
  // 41: the Reviewer's scaled budget is 328 and its own calibration needs 331;
  // the shared run ledger is short by 23 after the Coordinator and Builder.
  const at41 = preflightCapacity(41);
  expect(at41.verdict).toBe('refuse');
  expect(at41.findings.map((finding) => [finding.resource, finding.required, finding.limit]))
    .toEqual([['runToolCalls', 407, RUN_TOOL_LIMIT], ['reviewToolCalls', 331, 328]]);
  const at45 = preflightCapacity(45);
  expect(at45.verdict).toBe('refuse');
  expect(at45.findings.map((finding) => [finding.resource, finding.required, finding.limit]))
    .toEqual([['runToolCalls', 439, RUN_TOOL_LIMIT], ['reviewToolCalls', 363, 360]]);
  // Nothing here is near only: the evidence entry and artifact caps are far away,
  // which is why they are not the binding resource.
  expect(at45.required.evidenceEntries).toBe(473);
  expect(at45.required.evidenceBytes).toBe(1620 * 1024);
  expect(at45.required.artifacts).toBe(68);
  expect(at45.required.evidenceBytes).toBeLessThan(REVIEW_EVIDENCE_LIMIT_BYTES);
  expect(at45.required.artifacts).toBeLessThan(MAX_CHECK_ARTIFACTS);
});

test('the pre-flight passes at 34, batches exactly at 35 and refuses at 39', () => {
  // Boundary: 34 x 8 + 3 = 275 fits the 280 hard floor; 35 crosses it by 3.
  expect(preflightCapacity(34).verdict).toBe('ok');
  expect(preflightCapacity(34).findings).toEqual([]);
  const at35 = preflightCapacity(35);
  expect(at35.verdict).toBe('batch');
  expect(at35.findings.map((finding) => [finding.resource, finding.exceededBy])).toEqual([['reviewToolCalls', 3]]);
  expect(at35.maxBehavioursPerBatch).toBe(34);
  expect(at35.batches).toEqual([34, 1]);
  // Boundary: 12 + 64 + 307 = 383 fits the 384 run ledger; 39 needs 391.
  expect(preflightCapacity(38).verdict).toBe('batch');
  expect(preflightCapacity(38).required.runToolCalls).toBe(383);
  const at39 = preflightCapacity(39);
  expect(at39.verdict).toBe('refuse');
  expect(at39.findings.map((finding) => [finding.resource, finding.exceededBy])).toContainEqual(['runToolCalls', 7]);
  // Above the plan contract's own ceiling there is no valid plan to accept.
  const at81 = preflightCapacity(81);
  expect(at81.verdict).toBe('refuse');
  expect(at81.findings.map((finding) => finding.resource)).toContain('planBehaviours');
});

test('the refusal and the batching recommendation carry concrete numbers', () => {
  const refused = preflightCapacity(45);
  expect(refused.message).toContain('439');
  expect(refused.message).toContain('384');
  expect(refused.message).toContain('363');
  expect(refused.message).toContain('360');
  expect(refused.message).toContain('RUN_TOOL_LIMIT');
  expect(refused.unmeasuredInputs.join(' ')).toContain('BUILDER_TOOL_CALLS');
  const batched = preflightCapacity(35);
  expect(batched.message).toContain('283');
  expect(batched.message).toContain('280');
  expect(batched.message).toContain('34+1');
});

test('a plan that cannot fit even one batch is refused, with the resource named', () => {
  const refused = preflightCapacity(3, { limits: { evidenceBytes: 1 } });
  expect(refused.verdict).toBe('refuse');
  expect(refused.maxBehavioursPerBatch).toBe(0);
  expect(refused.batches).toEqual([]);
  expect(refused.message).toContain('evidenceBytes');
});

test('shadow mode changes nothing: it reports the same assessment and never throws', () => {
  expect(CAPACITY_ENFORCEMENT).toBe('shadow');
  const shadow = preflightCapacity(45);
  expect(shadow.mode).toBe('shadow');
  expect(shadow.enforced).toBe(false);
  // Enforce mode refuses the same plan with the same numbers; shadow returns them.
  expect(() => preflightCapacity(45, { mode: 'enforce' })).toThrowError(RuntimeError);
  try {
    preflightCapacity(45, { mode: 'enforce' });
  } catch (error) {
    expect((error as RuntimeError).code).toBe('CAPACITY_REFUSED');
    expect((error as RuntimeError).message).toBe(shadow.message);
  }
  for (const count of [1, 34, 35, 45, 80, 200]) expect(() => preflightCapacity(count)).not.toThrow();
  // No existing limit moved, and the proposal is a separate function.
  expect([REVIEW_TOOL_LIMIT, REVIEW_TOOL_LIMIT_CEILING, REVIEW_TOOL_CALLS_PER_BEHAVIOR, RUN_TOOL_LIMIT,
    REVIEW_EVIDENCE_LIMIT_BYTES, REVIEW_EVIDENCE_ENTRY_LIMIT, MAX_CHECK_ARTIFACTS, PLAN_BYTE_LIMIT, HANDOFF_BYTE_LIMIT,
    MAX_PLAN_BEHAVIORS]).toEqual([280, 600, 8, 384, 2 * 1024 * 1024, 4096, 80, 96 * 1024, 160 * 1024, 80]);
  expect(currentLimits(45).reviewToolCalls).toBe(360);
  expect(limits(45).reviewToolCalls).toBe(363);
});

test('the per-behaviour plan byte cost is re-measured from the schema, not assumed', () => {
  const measuredProse = bytes(BehaviorTargetSchema.parse(prose('B01')));
  const measuredCompiled = bytes(compiled('B01'));
  expect(measuredProse).toBe(BEHAVIOR_PROSE_BYTES);
  expect(measuredCompiled).toBe(BEHAVIOR_PLAN_BYTES);
  // The whole is the sum of its measured parts; a change to any part moves it.
  expect(BEHAVIOR_PROSE_BYTES + BEHAVIOR_ARRAY_SKELETON_BYTES + ASSUMED_STEPS_PER_BEHAVIOR * BEHAVIOR_STEP_BYTES
    + ASSUMED_ASSERTIONS_PER_BEHAVIOR * BEHAVIOR_ASSERTION_BYTES + BEHAVIOR_EVIDENCE_FLAG_BYTES
    + BEHAVIOR_CROSS_FIELD_PUNCTUATION_BYTES).toBe(BEHAVIOR_PLAN_BYTES);
  expect(bytes(BehaviorTargetSchema.parse({ ...prose('B01'), steps: [], assertions: [] })))
    .toBe(BEHAVIOR_PROSE_BYTES + BEHAVIOR_ARRAY_SKELETON_BYTES);
});

test('the plan byte model reproduces the serialized plans it claims to predict', () => {
  for (const count of [5, 14, 41, 45]) {
    const measured = bytes(fixturePlan(count));
    // PLAN_SCAFFOLD_BYTES + N x (behaviour + one group reference) is the model.
    expect(envelope(count).planBytes).toBe(measured);
    expect(measured).toBe(PLAN_SCAFFOLD_BYTES + count * (BEHAVIOR_PLAN_BYTES + 7));
  }
  // A realistic compiled plan is nowhere near the 96 KiB contract cap...
  expect(envelope(45).planBytes).toBeLessThan(0.5 * PLAN_BYTE_LIMIT);
  expect(preflightCapacity(45).findings.map((finding) => finding.resource)).not.toContain('planBytes');
  // ...but at the schema ceiling it is within 3% of it, which is the warning.
  const at80 = preflightCapacity(80);
  const planNear = at80.near.find((finding) => finding.resource === 'planBytes');
  expect(planNear?.required).toBe(95_898);
  expect(planNear!.required / PLAN_BYTE_LIMIT).toBeGreaterThan(0.97);
});

test('the plan contract ceiling the model uses is the schema’s real ceiling', () => {
  const atCeiling = fixturePlan(MAX_PLAN_BEHAVIORS);
  expect(atCeiling.behaviors).toHaveLength(MAX_PLAN_BEHAVIORS);
  expect(GroupedPlanSchema.safeParse(atCeiling).success).toBe(true);
  // One more behaviour is not expressible: the behavior array cap refuses it,
  // with the new id correctly grouped so the cap is the only reason.
  const overflow = { ...atCeiling, behaviors: [...atCeiling.behaviors, { ...atCeiling.behaviors[0], id: 'B81' }],
    groups: atCeiling.groups.map((group, index) => index === 4
      ? { ...group, behaviorIds: [...group.behaviorIds, 'B81'] } : group) };
  expect(GroupedPlanSchema.safeParse(overflow).success).toBe(false);
});

test('prose at the schema caps is the plan-byte risk, and the budget per behaviour shows it', () => {
  const maximal = BehaviorTargetSchema.parse({ id: 'B01', title: '标'.repeat(120), precondition: '前'.repeat(500),
    action: '动'.repeat(500), expected: '期'.repeat(500), required: true });
  expect(bytes(maximal)).toBe(MAXIMAL_PROSE_BEHAVIOR_BYTES);
  // Forty-five schema-max behaviours cannot be a valid plan at all.
  expect(45 * MAXIMAL_PROSE_BEHAVIOR_BYTES).toBeGreaterThan(PLAN_BYTE_LIMIT);
  expect(Math.floor((PLAN_BYTE_LIMIT - PLAN_SCAFFOLD_BYTES) / MAXIMAL_PROSE_BEHAVIOR_BYTES)).toBe(19);
  // The measured compiled shape fits the budget for the same count with 2.7x room.
  expect(BEHAVIOR_PLAN_BYTES).toBeLessThan(planByteBudgetPerBehavior(45));
  expect(planByteBudgetPerBehavior(45)).toBe(2168);
});

test('the handoff envelope covers the worse of the two handoffs against the same cap', () => {
  // The repair handoff carries five failed checks (data/generation.ts:1417-1418).
  expect(envelope(45).repairHandoffBytes).toBe(51_617);
  expect(envelope(45).handoffBytes).toBe(envelope(45).repairHandoffBytes);
  expect(envelope(45).handoffBytes).toBeLessThan(0.5 * HANDOFF_BYTE_LIMIT);
  expect(required(80).handoffBytes).toBeLessThan(HANDOFF_BYTE_LIMIT);
});
