import { BehaviorProgramSchema, ReviewItemSchema, type Plan } from '@pivloom/contracts';

/** Caller-owned limits. No throughput estimate or uncalibrated default is enforced here. */
export interface VerificationAdmissionBudget {
  remainingMs: number;
  maxSteps?: number;
  maxExpandedKeys?: number;
  maxExplicitWaitMs?: number;
  maxArtifacts?: number;
}

export interface VerificationAdmissionStats {
  behaviors: number;
  requiredBehaviors: number;
  /** Declared program entries, not remote command count. */
  steps: number;
  expandedKeys: number;
  explicitWaitMs: number;
  captures: number;
  missingPrograms: number;
  missingInitialState: number;
  targetAssertions: number;
  /** Explicit visual declarations, not a claim to infer pixel requirements from prose. */
  visualBehaviors: number;
  legacyPageTextAssertions: number;
}

export interface InvalidVerificationProgram {
  behaviorId: string;
  reason: 'missing-program' | 'missing-initial-state' | 'invalid-program';
  issues: Array<{ path: string; message: string }>;
}

export interface VerificationProgramAdmission {
  behaviorId: string;
  required: boolean;
  /** READY means structurally executable, never checked or passed. */
  disposition: 'READY' | 'NOT_RUN';
  failureKind: 'invalid-test' | 'not-run' | null;
  reason: string | null;
  legacyInitialState: boolean;
}

export interface VerificationBudgetExceeded {
  resource: 'steps' | 'expandedKeys' | 'explicitWaitMs' | 'remainingMs' | 'artifacts';
  required: number;
  limit: number;
  reason: 'exceeded' | 'exhausted';
}

/** Read-only accounting; calling this function does not execute or pass any check. */
export function admitVerification(plan: Plan, budget: VerificationAdmissionBudget) {
  const verificationMode = plan.verificationMode ?? 'programs';
  if (!Number.isFinite(budget.remainingMs)) throw new RangeError('remainingMs must be finite');
  for (const name of ['maxSteps', 'maxExpandedKeys', 'maxExplicitWaitMs', 'maxArtifacts'] as const) {
    const limit = budget[name];
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0))
      throw new RangeError(`${name} must be a nonnegative integer; omit an unconfigured limit`);
  }
  const remainingMs = Math.max(0, budget.remainingMs);
  const stats: VerificationAdmissionStats = { behaviors: plan.behaviors.length, requiredBehaviors: 0, steps: 0,
    expandedKeys: 0, explicitWaitMs: 0, captures: 0, missingPrograms: 0, missingInitialState: 0, targetAssertions: 0,
    visualBehaviors: 0, legacyPageTextAssertions: 0 };
  const invalidPrograms: InvalidVerificationProgram[] = [];
  const programs: VerificationProgramAdmission[] = [];
  for (const behavior of plan.behaviors) {
    let captures = 0;
    if (behavior.required) stats.requiredBehaviors++;
    if (behavior.evidence === 'visual') stats.visualBehaviors++;
    if (verificationMode === 'interactive') {
      // The parsed plan explicitly delegates observation-guided actions to the
      // existing Reviewer. Zero declared steps is unknown work, not zero work.
      programs.push({ behaviorId: behavior.id, required: behavior.required, disposition: 'READY',
        failureKind: null, reason: 'interactive-verification', legacyInitialState: false });
      continue;
    }
    if (!behavior.steps?.length || !behavior.assertions?.length) stats.missingPrograms++;
    if (behavior.initialState === undefined) stats.missingInitialState++;
    for (const assertion of behavior.assertions ?? []) {
      if ('target' in assertion) stats.targetAssertions++;
      if (assertion.kind === 'text') stats.legacyPageTextAssertions++;
    }
    for (const step of behavior.steps ?? []) {
      stats.steps++;
      if (step.type === 'press') stats.expandedKeys++;
      if (step.type === 'key_sequence') stats.expandedKeys += step.keys.length * step.repeat;
      if (step.type === 'wait') stats.explicitWaitMs += step.ms;
      if (step.type === 'capture') { captures++; stats.captures++; }
    }
    const missingProgram = !behavior.steps?.length || !behavior.assertions?.length;
    const modern = behavior.assertions?.some(assertion => 'target' in assertion)
      || behavior.steps?.some(step => step.type === 'key_sequence');
    const legacyInitialState = !missingProgram && !modern && behavior.initialState === undefined;
    // Match the reader's deliberate compatibility policy, while all executable
    // rules and limits are still owned by the real public program schema.
    const parsed = BehaviorProgramSchema.safeParse({ ...behavior,
      initialState: behavior.initialState ?? (legacyInitialState ? 'continue' : undefined) });
    const issues = parsed.success ? [] : parsed.error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message }));
    // Validate cardinality against the real persistence contract. These dummy
    // values are never emitted as evidence or artifacts; only the array limit matters.
    const references = ReviewItemSchema.shape.screenshotIds.safeParse(Array(captures).fill('00000000-0000-4000-8000-000000000000'));
    if (!references.success) issues.push(...references.error.issues.map(issue => ({ path: 'steps.capture',
      message: `截图数量超过单项可引用的持久化契约：${issue.message}` })));
    let invalid: InvalidVerificationProgram | undefined;
    if (issues.length) {
      invalid = { behaviorId: behavior.id,
        reason: missingProgram ? 'missing-program' : behavior.initialState === undefined && modern
          ? 'missing-initial-state' : 'invalid-program',
        issues };
      invalidPrograms.push(invalid);
    }
    programs.push({ behaviorId: behavior.id, required: behavior.required,
      disposition: invalid ? 'NOT_RUN' : 'READY', failureKind: invalid ? 'invalid-test' : null,
      reason: invalid?.reason ?? null, legacyInitialState });
  }
  const budgetExceeded: VerificationBudgetExceeded[] = [];
  const limits = [
    { resource: 'steps' as const, required: stats.steps, limit: budget.maxSteps },
    { resource: 'expandedKeys' as const, required: stats.expandedKeys, limit: budget.maxExpandedKeys },
    { resource: 'explicitWaitMs' as const, required: stats.explicitWaitMs, limit: budget.maxExplicitWaitMs },
    { resource: 'artifacts' as const, required: stats.captures, limit: budget.maxArtifacts },
    { resource: 'remainingMs' as const, required: stats.explicitWaitMs, limit: remainingMs },
  ];
  for (const { resource, required, limit } of limits)
    if (limit !== undefined && required > limit) budgetExceeded.push({ resource, required, limit, reason: 'exceeded' });
  if (remainingMs === 0)
    budgetExceeded.push({ resource: 'remainingMs', required: stats.explicitWaitMs, limit: 0, reason: 'exhausted' });
  // No truncation, batching guess, or partial execution is hidden in admission.
  // A caller can explicitly rescope a later request, but this request is NOT_RUN.
  if (budgetExceeded.length) for (const program of programs) {
    program.disposition = 'NOT_RUN';
    if (program.failureKind === null) {
      program.failureKind = 'not-run';
      program.reason = 'capacity-exceeded';
    }
  }
  const ready = programs.filter(program => program.disposition === 'READY').length;
  const decision = ready === programs.length ? 'ready' as const : ready > 0 ? 'partial' as const : 'not-run' as const;
  return { verificationMode, decision, stats, programs, invalidPrograms, budgetExceeded, timing: { explicitWaitMs: stats.explicitWaitMs, remainingMs,
    unmeasuredMs: null, completionGuarantee: false as const } };
}
