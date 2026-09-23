import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { CheckSchema, MAX_CHECK_ARTIFACTS } from '@pivloom/contracts';

test('80 maximum-length stored artifact entries fit the widened PostgreSQL JSONB boundary', () => {
  const artifacts = Array.from({ length: MAX_CHECK_ARTIFACTS }, () => ({
    id: randomUUID(), key: 'k'.repeat(512), bytes: 2 * 1024 * 1024,
    mimeType: 'image/png', sha256: 'a'.repeat(64),
  }));
  const compact = Buffer.byteLength(JSON.stringify(artifacts));
  // PostgreSQL jsonb::text inserts spaces after commas/colons. Sixteen bytes
  // extra per entry is above the maximum possible separator overhead here.
  const conservativeJsonbBytes = compact + 16 * artifacts.length;
  expect(conservativeJsonbBytes).toBeGreaterThan(16 * 1024);
  expect(conservativeJsonbBytes).toBeLessThanOrEqual(64 * 1024);
  const publicArtifacts = artifacts.map(({ id, mimeType, sha256 }) => ({ id, mimeType, sha256 }));
  const check = CheckSchema.safeParse({
    id: randomUUID(), runId: randomUUID(), roleRunId: randomUUID(), attempt: 0,
    revisionId: randomUUID(), sourceHash: 'b'.repeat(64), sandboxId: 'sandbox', browserSessionId: 'session',
    verdict: 'blocked', items: [], summary: 'Blocked', artifacts: publicArtifacts,
    createdAt: new Date().toISOString(),
  });
  expect(check.success).toBe(true);
});
