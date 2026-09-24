import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { summarizeReviewCheckpoint, type ProvisionalReviewCheckpoint } from '../../src/generation/review-checkpoint.js';

export function oversizedReviewCheckpoint(): ProvisionalReviewCheckpoint {
  const runId = randomUUID();
  const roleRunId = randomUUID();
  const revisionId = randomUUID();
  const observationEventIds = Array.from({ length: 32 }, () => randomUUID());
  const screenshotIds = Array.from({ length: 6 }, () => randomUUID());
  return {
    binding: { runId, roleRunId, attempt: 0, revisionId, sourceHash: 'a'.repeat(64),
      sandboxId: randomUUID(), browserSessionId: `pivloom-${randomUUID()}` },
    item: { behaviorId: 'B09', verdict: 'passed', expected: '可观察到真实自碰。',
      actual: '画面和游戏结束状态吻合。'.repeat(200), observationEventIds, screenshotIds,
      reproSteps: Array.from({ length: 8 }, () => '空格暂停、方向键移动、截图核对。'.repeat(30)) },
    completedBehaviorIds: ['B01', 'B02', 'B09', 'B09'], totalBehaviors: 15,
    evidence: observationEventIds.map((id) => ({ id, behaviorId: 'B09', action: 'browser_key_batch',
      observationId: randomUUID(), url: 'https://example.invalid/p/revision/',
      tree: '页面无障碍树。'.repeat(2_000), text: '游戏画面文本。'.repeat(2_000), truncated: false,
      batch: { startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
        steps: [{ index: 0, key: 'Space', waitMs: 165, success: true }] } })),
    artifacts: screenshotIds.map((id) => ({ id, mimeType: 'image/png', sha256: 'b'.repeat(64),
      key: `${runId}/${revisionId}/checks/${id}.png`, bytes: 1024 })),
  };
}

describe('review checkpoint audit summary', () => {
  test('keeps every reference and source binding within the event budget without treating it as a Check', () => {
    const checkpoint = oversizedReviewCheckpoint();
    const summary = summarizeReviewCheckpoint(checkpoint);
    const payload = { toolName: 'review_checkpoint', message: '已保存经真实证据校验的暂存行为结论。', reviewCheckpoint: summary };
    expect(Buffer.byteLength(JSON.stringify(payload), 'utf8')).toBeLessThan(16 * 1024);
    expect(Buffer.byteLength(JSON.stringify(summary), 'utf8')).toBeLessThanOrEqual(8 * 1024);
    expect(summary.provisional).toBe(true);
    expect(summary.binding).toEqual(checkpoint.binding);
    expect(summary.item.behaviorId).toBe('B09');
    expect(summary.item.verdict).toBe('passed');
    expect(summary.item.observationEventIds).toEqual(checkpoint.item.observationEventIds);
    expect(summary.item.screenshotIds).toEqual(checkpoint.item.screenshotIds);
    expect(summary.completedBehaviorIds).toEqual(['B01', 'B02', 'B09']);
    expect(summary.totalBehaviors).toBe(15);
    expect(summary.detailsTruncated).toBe(true);
    expect(summary).not.toHaveProperty('groups');
  });
});
