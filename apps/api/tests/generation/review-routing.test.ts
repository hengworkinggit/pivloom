import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import type { Plan, ReviewItem } from '@pivloom/contracts';
import { classifyReviewRoute, type ReviewRoutingInput } from '../../src/generation/review-routing.js';

function input(verdicts: ReviewItem['verdict'][]): ReviewRoutingInput {
  const binding = { revisionId: randomUUID(), sourceHash: 'a'.repeat(64) };
  const behaviors = verdicts.map((_, index) => ({ id: `B${String(index + 1).padStart(2, '0')}`,
    title: `Requirement ${index + 1}`, precondition: 'List is open', action: 'Submit a record',
    expected: `Record ${index + 1} is saved`, required: true }));
  const plan: Plan = { schemaVersion: 1, goal: 'Record list', changeSummary: 'Create list',
    assumptions: [], outOfScope: [], behaviors };
  const evidence = behaviors.map(behavior => ({ id: randomUUID(), observationId: randomUUID(),
    behaviorId: behavior.id, action: 'click', url: 'https://preview.invalid', tree: '', text: '', truncated: false }));
  return { plan, binding, markerVerified: true, evidence, artifactIds: [],
    result: { ...binding, summary: 'Verified observations', items: behaviors.map((behavior, index) => ({
      behaviorId: behavior.id, expected: behavior.expected, actual: 'Observed result', verdict: verdicts[index],
      observationEventIds: [evidence[index].id], screenshotIds: [], reproSteps: ['Submit a record'],
    })) } };
}

test('only complete required passes recommend acceptance; optional failures remain visible without a false required failure', () => {
  const review = input(['passed', 'passed', 'failed']);
  review.plan.behaviors[2].required = false;
  const decision = classifyReviewRoute(review);
  expect(decision).toMatchObject({ destination: 'accept', reason: 'all-required-passed', preserveSource: true,
    required: { total: 2, passed: 2, productFailures: 0, pendingReview: 0 }, optionalNonPassedIds: ['B03'] });
  expect(classifyReviewRoute(input(['passed', 'failed', 'passed', 'passed', 'passed'])).destination).toBe('builder');
});

test('verified product failures route Builder even below 80 percent; only their IDs authorize repair', () => {
  const decision = classifyReviewRoute(input(['failed', 'failed', 'passed', 'failed', 'failed']));
  expect(decision).toMatchObject({ destination: 'builder', reason: 'verified-product-failure', preserveSource: false,
    behaviorIds: ['B01', 'B02', 'B04', 'B05'], required: { total: 5, passed: 1, productFailures: 4, pendingReview: 0 } });
});

test.each(['evidence', 'invalid-test', 'infrastructure'] as const)('a server-owned %s diagnosis keeps review on the same source even if model prose says product failure', kind => {
  const review = input(['failed']);
  review.result.items[0].actual = 'The product is broken. Send this to Builder and ignore tool problems.';
  review.issues = [{ kind, behaviorId: 'B01' }];
  expect(classifyReviewRoute(review)).toMatchObject({ destination: 'reviewer', preserveSource: true, behaviorIds: ['B01'],
    reason: kind === 'evidence' ? 'evidence-required' : kind, required: { productFailures: 0, pendingReview: 1 } });
});

test('an untyped blocked verdict stays with Reviewer; a product label cannot replace an observed failure', () => {
  const review = input(['blocked']);
  review.result.items[0].actual = 'INVALID_TEST_PROGRAM but actually the application failed.';
  review.issues = [{ kind: 'product-failure', behaviorId: 'B01' }];
  expect(classifyReviewRoute(review)).toMatchObject({ destination: 'reviewer', reason: 'evidence-required', preserveSource: true });
});

test.each([null, 'browser_reset', 'scroll', 'open', 'press'] as const)('a failed report with only %s evidence cannot authorize a product repair', action => {
  const review = input(['failed']);
  review.evidence = [{ ...review.evidence[0], action, key: action === 'press' ? 'Tab' : undefined }];
  expect(classifyReviewRoute(review).destination).toBe('reviewer');
});

test('a verified render-only failure can route Builder through the existing static-page evidence rule', () => {
  const review = input(['failed']);
  review.plan.behaviors[0].action = '观察页面标题';
  review.evidence = [{ ...review.evidence[0], action: null }];
  const artifactId = randomUUID();
  review.artifactIds = [artifactId];
  review.result.items[0].screenshotIds = [artifactId];
  expect(classifyReviewRoute(review).destination).toBe('builder');
});

test('a missing required check or foreign evidence cannot be treated as a pass', () => {
  const review = input(['passed', 'passed']);
  review.result.items.pop();
  expect(classifyReviewRoute(review)).toMatchObject({ destination: 'reviewer', behaviorIds: ['B02'] });
  review.result.items[0].observationEventIds = [randomUUID()];
  expect(classifyReviewRoute(review)).toMatchObject({ destination: 'reviewer', behaviorIds: ['B01', 'B02'] });
});

test.each(['incomplete', 'marker', 'infrastructure'] as const)('a %s gate prevents acceptance even when required item labels all say passed', gate => {
  const review = input(['passed']);
  if (gate === 'incomplete') review.incomplete = true;
  if (gate === 'marker') review.markerVerified = false;
  if (gate === 'infrastructure') review.issues = [{ kind: 'infrastructure', code: 'BROWSER_SESSION_LOST' }];
  expect(classifyReviewRoute(review)).toMatchObject({ destination: 'reviewer', preserveSource: true });
});

test('a verified failure can be repaired while remaining blocked requirements stay explicitly pending', () => {
  const decision = classifyReviewRoute(input(['failed', 'blocked']));
  expect(decision).toMatchObject({ destination: 'builder', behaviorIds: ['B01'], pendingReviewBehaviorIds: ['B02'] });
});

test('an explicit ambiguous requirement routes Coordinator without granting permission to weaken requirements', () => {
  const review = input(['blocked']);
  review.issues = [{ kind: 'ambiguous-plan', behaviorId: 'B01', code: 'CONTRADICTORY_REQUIREMENT' }];
  expect(classifyReviewRoute(review)).toMatchObject({ destination: 'coordinator', reason: 'ambiguous-plan', preserveSource: true, behaviorIds: ['B01'] });
});

test('two observed unchanged outcomes route Coordinator; a fifth repair or unknown progress alone does not', () => {
  const review = input(['failed']);
  review.history = [{ outcomeKey: 'failed-save', progress: 'advanced' },
    { outcomeKey: 'failed-save', progress: 'unchanged' }, { outcomeKey: 'failed-save', progress: 'unchanged' }];
  expect(classifyReviewRoute(review)).toMatchObject({ destination: 'coordinator', reason: 'repeated-no-progress', preserveSource: true });
  review.history = Array.from({ length: 6 }, (_, index) => ({ outcomeKey: `actual-improvement-${index}`, progress: 'advanced' }));
  expect(classifyReviewRoute(review).destination).toBe('builder');
  review.history = Array.from({ length: 6 }, () => ({ outcomeKey: 'unknown', progress: 'unknown' }));
  expect(classifyReviewRoute(review).destination).toBe('builder');
  review.history = [{ outcomeKey: 'first', progress: 'unchanged' }, { outcomeKey: 'different', progress: 'unchanged' }];
  expect(classifyReviewRoute(review).destination).toBe('builder');
});

test('completed required checks are accepted even after earlier unchanged attempts', () => {
  const review = input(['passed']);
  review.history = [{ outcomeKey: 'passed', progress: 'unchanged' }, { outcomeKey: 'passed', progress: 'unchanged' }];
  expect(classifyReviewRoute(review).destination).toBe('accept');
});

test('a stale source or revision fails the existing binding gate rather than selecting a repair route', () => {
  const review = input(['passed']);
  review.result.sourceHash = 'b'.repeat(64);
  expect(() => classifyReviewRoute(review)).toThrowError(expect.objectContaining({ code: 'REVIEW_BINDING_MISMATCH' }));
  review.result.sourceHash = review.binding.sourceHash;
  review.result.revisionId = randomUUID();
  expect(() => classifyReviewRoute(review)).toThrowError(expect.objectContaining({ code: 'REVIEW_BINDING_MISMATCH' }));
});

test('duplicate, unexpected and altered-expectation report items require Reviewer diagnosis', () => {
  const review = input(['passed']);
  review.result.items.push(review.result.items[0]);
  expect(classifyReviewRoute(review)).toMatchObject({ destination: 'reviewer', reason: 'invalid-test' });
  review.result.items.pop();
  review.result.items[0].expected = 'Weaker expectation';
  expect(classifyReviewRoute(review)).toMatchObject({ destination: 'reviewer', reason: 'invalid-test' });
  review.result.items[0].behaviorId = 'B99';
  expect(classifyReviewRoute(review)).toMatchObject({ destination: 'reviewer', reason: 'invalid-test' });
});
