import type { BehaviorTarget } from '@pivloom/contracts';
import { RuntimeError } from './types.js';

/** A partial execution never edits the sealed plan or supplies prior-session evidence. */
export function selectReviewBehaviors(behaviors: BehaviorTarget[], ids?: readonly string[]): BehaviorTarget[] {
  if (!ids) return behaviors;
  const selected = new Set(ids);
  if (!selected.size || selected.size !== ids.length || ids.some(id => !behaviors.some(behavior => behavior.id === id)))
    throw new RuntimeError('INVALID_REVIEW_SCOPE', '续验范围不属于当前完整计划');
  return behaviors.filter(behavior => selected.has(behavior.id));
}
