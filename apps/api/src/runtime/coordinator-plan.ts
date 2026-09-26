import { z } from 'zod';
import { BehaviorTargetSchema, GroupedPlanSchema, GroupIdSchema, VerificationModeSchema, preservesPreviousBehavior,
  type BehaviorTarget, type GroupedPlan, type Plan, type PlanningContext } from '@pivloom/contracts';

/** Coordinator describes requirements. Browser programs belong to Reviewer preparation. */
const requirement = BehaviorTargetSchema.pick({ title: true, precondition: true, action: true, expected: true, required: true })
  .extend({ required: z.boolean().optional() });
const note = z.string().trim().min(1).max(500);
export const CoordinatorIncrementSchema = z.strictObject({
  changeSummary: GroupedPlanSchema.shape.changeSummary,
  verificationMode: VerificationModeSchema.optional(),
  additions: z.array(z.strictObject({ groupId: GroupIdSchema, requirement })).max(80).default([]),
  replacements: z.array(z.strictObject({ oldBehaviorId: BehaviorTargetSchema.shape.id, requirement,
    userRequestQuote: note, reason: note })).max(80).default([]),
});
export type CoordinatorIncrement = z.infer<typeof CoordinatorIncrementSchema>;

/** Full-plan compatibility: fill only omitted fields, never correct an explicit rewrite. */
export function inheritCoordinatorPrograms(plan: GroupedPlan, previous: Plan | null): GroupedPlan {
  const byId = new Map(previous?.behaviors.map(behavior => [behavior.id, behavior]));
  return { ...plan, verificationMode: plan.verificationMode ?? previous?.verificationMode ?? 'programs',
    behaviors: plan.behaviors.map(behavior => {
    const prior = byId.get(behavior.id);
    if (!prior) return behavior;
    return { ...behavior,
      ...(behavior.steps === undefined && prior.steps ? { steps: prior.steps } : {}),
      ...(behavior.assertions === undefined && prior.assertions ? { assertions: prior.assertions } : {}),
      ...(behavior.initialState === undefined && prior.initialState ? { initialState: prior.initialState } : {}),
      ...(behavior.evidence === undefined && prior.evidence ? { evidence: prior.evidence } : {}),
    };
  }) };
}

/** Service-owned composition retains all previous groups, requirements and executable assets. */
export function composeCoordinatorIncrement(increment: CoordinatorIncrement, previous: Plan | null, requestText: string): GroupedPlan {
  if (!previous || previous.schemaVersion !== 2)
    throw new Error('submit_increment requires a previous five-group plan; use submit_plan for an initial or legacy flat plan.');
  const next = structuredClone(previous);
  next.changeSummary = increment.changeSummary;
  next.verificationMode = increment.verificationMode ?? previous.verificationMode ?? 'programs';
  const used = new Set([...previous.behaviors.map(behavior => behavior.id),
    ...previous.replacements.flatMap(replacement => [replacement.oldBehaviorId, replacement.newBehaviorId])]);
  const allocateId = () => {
    for (let value = 1; value <= 99; value++) {
      const id = `B${String(value).padStart(2, '0')}`;
      if (!used.has(id)) { used.add(id); return id; }
    }
    throw new Error('No unused behavior ID remains; an increment cannot reuse retired IDs or omit preserved requirements.');
  };
  const replaced = new Set<string>();
  for (const replacement of increment.replacements) {
    const index = next.behaviors.findIndex(behavior => behavior.id === replacement.oldBehaviorId);
    if (index < 0 || replaced.has(replacement.oldBehaviorId))
      throw new Error(`Replacement ${replacement.oldBehaviorId} must name one existing behavior exactly once.`);
    replaced.add(replacement.oldBehaviorId);
    const old = next.behaviors[index];
    const id = allocateId();
    const incoming: BehaviorTarget = { ...replacement.requirement, id, required: replacement.requirement.required ?? old.required };
    next.behaviors[index] = incoming;
    for (const group of next.groups) group.behaviorIds = group.behaviorIds.map(value => value === old.id ? id : value);
    next.replacements.push({ oldBehaviorId: old.id, newBehaviorId: id,
      userRequestQuote: replacement.userRequestQuote, reason: replacement.reason });
  }
  for (const addition of increment.additions) {
    const group = next.groups.find(group => group.id === addition.groupId);
    if (!group) throw new Error(`Unknown existing group ${addition.groupId}.`);
    const id = allocateId();
    next.behaviors.push({ ...addition.requirement, id, required: addition.requirement.required ?? true });
    group.behaviorIds.push(id);
  }
  const parsed = GroupedPlanSchema.parse(next);
  if (!preservesPreviousBehavior(parsed, previous, requestText))
    throw new Error('Increment cannot change preserved criteria or verification mode; replacement needs an explicit verbatim user-requested change and the original required flag.');
  return parsed;
}

/** Requirements remain readable; saved programs are indicated without repeating their large bodies. */
export function coordinatorProjectSummary(context: PlanningContext) {
  const previous = context.previousPlan;
  return { ...context,
    previousPlan: previous ? { ...previous, behaviors: previous.behaviors.map(({ id, title, precondition, action, expected, required }) =>
      ({ id, title, precondition, action, expected, required })) } : null,
    sealedProgramBehaviorIds: previous?.behaviors.filter(behavior => behavior.steps !== undefined
      || behavior.assertions !== undefined || behavior.initialState !== undefined).map(behavior => behavior.id) ?? [],
    canSubmitIncrement: previous?.schemaVersion === 2,
  };
}
