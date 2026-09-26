import { createHash } from 'node:crypto';
import { z } from 'zod';
import { BehaviorProgramSchema, BehaviorTargetSchema, PlanSchema, type BehaviorTarget, type Plan } from '@pivloom/contracts';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** A program implements an immutable requirement; titles and execution metadata
 * are not the requirement's identity. Ordinary increments reuse this identity. */
export function verificationRequirementHash(behavior: BehaviorTarget): string {
  return digest({ id: behavior.id, precondition: behavior.precondition, action: behavior.action,
    expected: behavior.expected, required: behavior.required });
}

export const VerificationProgramSpecSchema = BehaviorProgramSchema.safeExtend({
  evidence: z.enum(['text', 'visual']),
}).superRefine((program, context) => {
  if (program.evidence === 'text' && !program.assertions.some(assertion => assertion.kind.startsWith('target-')))
    context.addIssue({ code: 'custom', path: ['assertions'], message: '功能判定必须检查明确结果目标；页面全文或控制台无错误不能代替业务结果。' });
  if (program.evidence === 'visual' && !program.steps.some(step => step.type === 'capture'))
    context.addIssue({ code: 'custom', path: ['steps'], message: '视觉判定必须实际截图。' });
});
export type VerificationProgramSpec = z.infer<typeof VerificationProgramSpecSchema>;
export const VerificationProgramAssetSchema = z.strictObject({
  behaviorId: BehaviorTargetSchema.shape.id,
  requirementHash: z.string().regex(/^[a-f0-9]{64}$/),
  program: VerificationProgramSpecSchema,
  programHash: z.string().regex(/^[a-f0-9]{64}$/),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type VerificationProgramAsset = z.infer<typeof VerificationProgramAssetSchema>;

export function verificationProgramHash(program: VerificationProgramSpec): string {
  return digest(VerificationProgramSpecSchema.parse(program));
}

/** The production adapter is owner/project scoped. The compiler never chooses
 * that scope, and a saved program cannot be silently overwritten on a retry. */
export interface VerificationProgramCache {
  load(plan: Plan): Promise<VerificationProgramAsset[]>;
  save(assets: VerificationProgramAsset[]): Promise<VerificationProgramAsset[]>;
}

/** Decorate a plan for Builder/Reviewer without asking the Coordinator to copy
 * old criteria or programs. Existing embedded programs remain authoritative. */
export function applyVerificationPrograms(plan: Plan, assets: readonly VerificationProgramAsset[]): Plan {
  const byId = new Map(assets.map(asset => [asset.behaviorId, VerificationProgramAssetSchema.parse(asset)]));
  return PlanSchema.parse({ ...plan, behaviors: plan.behaviors.map(behavior => {
    const asset = byId.get(behavior.id);
    if (!asset || asset.requirementHash !== verificationRequirementHash(behavior)
      || asset.programHash !== verificationProgramHash(asset.program)) return behavior;
    if (behavior.steps?.length || behavior.assertions?.length) return behavior;
    if (plan.verificationMode === 'interactive') return behavior;
    return { ...behavior, ...asset.program };
  }) });
}
