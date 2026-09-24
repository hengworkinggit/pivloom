import type { ReviewBinding, ReviewItem } from '@pivloom/contracts';
import type { ReviewObservationEvent } from '../runtime/reviewer.js';
import type { StoredArtifact } from '../storage/artifacts.js';

/** A bounded audit note, never a Check or permission to accept a revision. */
export interface ProvisionalReviewCheckpoint {
  binding: ReviewBinding;
  item: ReviewItem;
  completedBehaviorIds: string[];
  totalBehaviors: number;
  evidence: ReviewObservationEvent[];
  artifacts: StoredArtifact[];
}

const MAX_SUMMARY_BYTES = 8 * 1024;
const MAX_OBSERVATION_DETAILS = 8;

export function summarizeReviewCheckpoint(checkpoint: ProvisionalReviewCheckpoint) {
  const item = checkpoint.item;
  const summary = {
    provisional: true as const,
    binding: checkpoint.binding,
    item: {
      behaviorId: item.behaviorId,
      verdict: item.verdict,
      observationEventIds: [...item.observationEventIds],
      screenshotIds: [...item.screenshotIds],
      expected: '',
      actual: '',
      reproSteps: [] as string[],
    },
    completedBehaviorIds: [...new Set(checkpoint.completedBehaviorIds)],
    totalBehaviors: checkpoint.totalBehaviors,
    observations: checkpoint.evidence.map((event) => ({
      id: event.id, observationId: event.observationId,
      action: undefined as string | undefined,
      key: undefined as string | undefined,
      batch: undefined as ReviewObservationEvent['batch'],
      url: undefined as string | undefined,
      text: undefined as string | undefined,
      tree: undefined as string | undefined,
    })),
    artifacts: checkpoint.artifacts.map((artifact) => ({
      id: artifact.id, sha256: artifact.sha256, bytes: artifact.bytes,
      key: undefined as string | undefined,
    })),
    detailsTruncated: false,
  };
  const bytes = () => Buffer.byteLength(JSON.stringify(summary), 'utf8');
  const addText = (assign: (value: string) => void, value: string | null | undefined, maxChars: number) => {
    if (!value) return;
    const clipped = value.slice(0, maxChars);
    let low = 0;
    let high = clipped.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      assign(clipped.slice(0, middle));
      if (bytes() <= MAX_SUMMARY_BYTES) low = middle;
      else high = middle - 1;
    }
    assign(clipped.slice(0, low));
    if (low < value.length) summary.detailsTruncated = true;
  };
  const addValue = <T>(assign: (value: T | undefined) => void, value: T | undefined) => {
    if (value === undefined) return;
    assign(value);
    if (bytes() > MAX_SUMMARY_BYTES) {
      assign(undefined);
      summary.detailsTruncated = true;
    }
  };

  addText((value) => { summary.item.actual = value; }, item.actual, 1_000);
  addText((value) => { summary.item.expected = value; }, item.expected, 600);
  for (const step of item.reproSteps) {
    const index = summary.item.reproSteps.length;
    summary.item.reproSteps.push('');
    if (bytes() > MAX_SUMMARY_BYTES) {
      summary.item.reproSteps.pop();
      summary.detailsTruncated = true;
      break;
    }
    addText((value) => { summary.item.reproSteps[index] = value; }, step, 200);
  }
  if (summary.item.reproSteps.length < item.reproSteps.length) summary.detailsTruncated = true;

  for (const [index, event] of checkpoint.evidence.entries()) {
    if (index >= MAX_OBSERVATION_DETAILS) {
      summary.detailsTruncated = true;
      break;
    }
    const output = summary.observations[index];
    addText((value) => { output.action = value || undefined; }, event.action, 160);
    addText((value) => { output.url = value || undefined; }, event.url, 180);
    addValue((value) => { output.key = value; }, event.key);
    if (event.batch) addValue((value) => { output.batch = value; }, event.batch);
    addText((value) => { output.text = value || undefined; }, event.text, 180);
    addText((value) => { output.tree = value || undefined; }, event.tree, 120);
  }
  for (const [index, artifact] of checkpoint.artifacts.entries()) {
    addText((value) => { summary.artifacts[index].key = value || undefined; }, artifact.key, 180);
  }
  if (bytes() > MAX_SUMMARY_BYTES) throw new Error('review checkpoint references exceed 8 KiB');
  return summary;
}
