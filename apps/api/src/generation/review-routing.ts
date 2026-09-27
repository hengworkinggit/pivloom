import { allowsRenderOnlyEvidence, type Plan, type ReviewBinding, type ReviewResult } from '@pivloom/contracts';
import type { ReviewObservationEvent } from '../runtime/reviewer.js';
import { RuntimeError } from '../runtime/types.js';

/** Service-owned diagnoses, derived from verified receipt/runtime codes, never model prose. */
export type ReviewRoutingIssueKind = 'product-failure' | 'evidence' | 'invalid-test' | 'infrastructure' | 'ambiguous-plan';
export interface ReviewRoutingIssue {
  kind: ReviewRoutingIssueKind;
  /** Omitted means the diagnosis affects the whole review. */
  behaviorId?: string;
  code?: string;
}
/** Real comparisons of successive outcomes. Unknown is not evidence of stagnation. */
export interface ReviewRoutingProgress {
  outcomeKey: string;
  progress: 'advanced' | 'unchanged' | 'unknown';
}
export interface ReviewRoutingInput {
  plan: Plan;
  result: ReviewResult;
  binding: Pick<ReviewBinding, 'revisionId' | 'sourceHash'>;
  markerVerified: boolean;
  evidence: readonly ReviewObservationEvent[];
  artifactIds: readonly string[];
  /** Deadline/collection/persistence incompleteness from the owning review. */
  incomplete?: boolean;
  issues?: readonly ReviewRoutingIssue[];
  /** Includes the current completed outcome; callers must not append timer ticks or model claims. */
  history?: readonly ReviewRoutingProgress[];
}
export interface ReviewRoutingDecision {
  destination: 'accept' | 'builder' | 'reviewer' | 'coordinator';
  reason: 'all-required-passed' | 'verified-product-failure' | 'evidence-required' | 'invalid-test'
    | 'infrastructure' | 'ambiguous-plan' | 'repeated-no-progress' | 'binding-not-verified' | 'incomplete-review';
  /** A routing recommendation never changes the source. False only authorizes Builder repair work. */
  preserveSource: boolean;
  behaviorIds: string[];
  pendingReviewBehaviorIds: string[];
  optionalNonPassedIds: string[];
  required: { total: number; passed: number; productFailures: number; pendingReview: number };
}

/**
 * Pure policy after the existing receipt, build, source and version gates. This does not issue a
 * receipt or authorize promotion: callers must keep those gates and the atomic persistence check.
 */
export function classifyReviewRoute(input: ReviewRoutingInput): ReviewRoutingDecision {
  if (input.result.revisionId !== input.binding.revisionId || input.result.sourceHash !== input.binding.sourceHash)
    throw new RuntimeError('REVIEW_BINDING_MISMATCH', '检查路由与候选版本不一致');
  const required = input.plan.behaviors.filter(behavior => behavior.required);
  const targets = new Map(input.plan.behaviors.map(behavior => [behavior.id, behavior]));
  const items = new Map(input.result.items.map(item => [item.behaviorId, item]));
  const observations = new Map(input.evidence.map(event => [event.id, event]));
  const artifacts = new Set(input.artifactIds);
  const issues = (input.issues ?? []).filter(issue => !issue.behaviorId || targets.get(issue.behaviorId)?.required);
  const invalidReport = targets.size !== input.plan.behaviors.length || items.size !== input.result.items.length
    || observations.size !== input.evidence.length || artifacts.size !== input.artifactIds.length
    || input.result.items.some(item => item.expected !== targets.get(item.behaviorId)?.expected)
    || (input.issues ?? []).some(issue => issue.behaviorId && !targets.has(issue.behaviorId));
  const passed: string[] = [], productFailures: string[] = [], pending: string[] = [];
  const validAction = (event: ReviewObservationEvent | undefined) => !!event
    && ['click', 'fill', 'select', 'press', 'reload', 'wait', 'key_batch'].includes(event.action ?? '')
    && !(event.action === 'press' && event.key === 'Tab')
    && !(event.action === 'key_batch' && (!event.batch?.steps.length || event.batch.steps.some(step => !step.success)));
  for (const behavior of required) {
    const item = items.get(behavior.id);
    const cited = item?.observationEventIds.map(id => observations.get(id)) ?? [];
    const evidence = item && item.expected === behavior.expected && cited.length > 0 && cited.every(Boolean)
      && item.screenshotIds.every(id => artifacts.has(id))
      && (cited.some(validAction) || allowsRenderOnlyEvidence(behavior) && item.screenshotIds.length > 0);
    const diagnosed = issues.some(issue => (!issue.behaviorId || issue.behaviorId === behavior.id)
      && (issue.kind !== 'product-failure' || item?.verdict !== 'failed'));
    if (invalidReport || diagnosed) pending.push(behavior.id);
    else if (item?.verdict === 'passed' && evidence) passed.push(behavior.id);
    else if (item?.verdict === 'failed' && evidence) productFailures.push(behavior.id);
    else pending.push(behavior.id);
  }
  const base = {
    pendingReviewBehaviorIds: pending,
    optionalNonPassedIds: input.plan.behaviors.filter(behavior => !behavior.required
      && items.get(behavior.id)?.verdict !== 'passed').map(behavior => behavior.id),
    required: { total: required.length, passed: passed.length, productFailures: productFailures.length, pendingReview: pending.length },
  };
  const unresolved = required.filter(behavior => !passed.includes(behavior.id)).map(behavior => behavior.id);
  const review = (reason: ReviewRoutingDecision['reason'], behaviorIds = pending): ReviewRoutingDecision =>
    ({ ...base, destination: 'reviewer', reason, preserveSource: true, behaviorIds });
  if (!input.markerVerified) return review('binding-not-verified', required.map(behavior => behavior.id));
  if (input.incomplete) return review('incomplete-review', unresolved.length ? unresolved : required.map(behavior => behavior.id));
  if (invalidReport) return review('invalid-test');
  if (!required.length || issues.some(issue => issue.kind === 'ambiguous-plan'))
    return { ...base, destination: 'coordinator', reason: 'ambiguous-plan', preserveSource: true, behaviorIds: unresolved };
  if (passed.length === required.length) return { ...base, destination: 'accept', reason: 'all-required-passed', preserveSource: true, behaviorIds: passed };
  const latest = input.history?.at(-1), previous = input.history?.at(-2);
  if (latest?.progress === 'unchanged' && previous?.progress === 'unchanged'
    && latest.outcomeKey.trim() && latest.outcomeKey === previous.outcomeKey)
    return { ...base, destination: 'coordinator', reason: 'repeated-no-progress', preserveSource: true, behaviorIds: unresolved };
  // Known product faults can be repaired while other IDs remain explicitly pending. A blocked item
  // or diagnosis does not become a product fault merely because another item really failed.
  if (productFailures.length) return { ...base, destination: 'builder', reason: 'verified-product-failure', preserveSource: false, behaviorIds: productFailures };
  if (issues.some(issue => issue.kind === 'invalid-test')) return review('invalid-test');
  if (issues.some(issue => issue.kind === 'infrastructure')) return review('infrastructure');
  return review('evidence-required');
}
