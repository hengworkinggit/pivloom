import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { REVIEW_EVIDENCE_ENTRY_LIMIT, REVIEW_EVIDENCE_LIMIT_BYTES } from '../../src/runtime/budgets.js';
import {
  EVIDENCE_PERSISTENCE_WRAPPER_BYTES, REVIEW_EVIDENCE_PERSISTENCE_LIMIT_BYTES,
} from '../../src/runtime/capacity.js';
import { assertReviewEvidenceFitsPersistence, parseReviewEvidence, REVIEW_EVIDENCE_LIMIT } from '../../src/data/generation.js';
import type { ReviewObservationEvent } from '../../src/runtime/reviewer.js';

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

function entry(): ReviewObservationEvent {
  return { id: randomUUID(), behaviorId: 'B01', action: 'click', observationId: randomUUID(),
    url: 'http://127.0.0.1:4173/', tree: '', text: '', truncated: false };
}

/**
 * An evidence array whose serialized JSON is exactly `target` bytes. Entries
 * carry up to 12000 characters of tree and of text (data/generation.ts:266), so
 * each one can absorb 24000 ASCII bytes and the last one is padded to the byte.
 */
function evidenceOfBytes(target: number): ReviewObservationEvent[] {
  const entries: ReviewObservationEvent[] = [];
  for (;;) {
    const before = bytes(entries);
    const candidate = entry();
    const overhead = bytes([...entries, candidate]) - before;
    const remaining = target - before;
    if (remaining < overhead) throw new Error('target too small for one evidence entry');
    if (remaining - overhead <= 24_000) {
      const padding = remaining - overhead;
      candidate.tree = 'x'.repeat(Math.min(padding, 12_000));
      candidate.text = 'y'.repeat(padding - candidate.tree.length);
      entries.push(candidate);
      return entries;
    }
    candidate.tree = 'x'.repeat(12_000);
    candidate.text = 'y'.repeat(12_000);
    entries.push(candidate);
  }
}

test('the persistence evidence bound is the reviewer’s bound plus its own wrapper, from one source', () => {
  // reviewer.ts:284 measures JSON.stringify(evidence) against this constant.
  expect(REVIEW_EVIDENCE_LIMIT_BYTES).toBe(2 * 1024 * 1024);
  expect(EVIDENCE_PERSISTENCE_WRAPPER_BYTES).toBe(bytes({ evidence: [] }) - bytes([]));
  expect(EVIDENCE_PERSISTENCE_WRAPPER_BYTES).toBe(13);
  expect(REVIEW_EVIDENCE_PERSISTENCE_LIMIT_BYTES).toBe(REVIEW_EVIDENCE_LIMIT_BYTES + EVIDENCE_PERSISTENCE_WRAPPER_BYTES);
  // The retired literal was 512 KiB; nothing may derive from it again.
  expect(REVIEW_EVIDENCE_PERSISTENCE_LIMIT_BYTES).toBeGreaterThan(512 * 1024);
  // One source for the entry cap too: budgets.ts defines it, generation.ts re-exports it.
  expect(REVIEW_EVIDENCE_LIMIT).toBe(REVIEW_EVIDENCE_ENTRY_LIMIT);
  expect(REVIEW_EVIDENCE_ENTRY_LIMIT).toBe(4096);
});

test('persistence accepts exactly what the reviewer admits, down to the byte', () => {
  const atBoundary = evidenceOfBytes(REVIEW_EVIDENCE_LIMIT_BYTES);
  expect(bytes(atBoundary)).toBe(REVIEW_EVIDENCE_LIMIT_BYTES);
  // The reviewer's own comparison is `> limit`, so exactly the limit is admitted
  // (reviewer.ts:284); persistence must therefore admit it too.
  expect(() => assertReviewEvidenceFitsPersistence(atBoundary)).not.toThrow();
  expect(parseReviewEvidence(atBoundary)).toHaveLength(atBoundary.length);

  const overByOne = evidenceOfBytes(REVIEW_EVIDENCE_LIMIT_BYTES + 1);
  expect(() => assertReviewEvidenceFitsPersistence(overByOne)).toThrowError(/执行记录超过大小限制/);
  try {
    assertReviewEvidenceFitsPersistence(overByOne);
  } catch (error) {
    expect((error as { code?: string }).code).toBe('EVENT_TOO_LARGE');
  }
});

test('a check that the old 512 KiB literal rejected is now persisted unchanged', () => {
  // This is the drift that lost a completed forty-four behaviour review: the
  // reviewer was happy and the save path threw EVENT_TOO_LARGE.
  const previouslyRejected = evidenceOfBytes(512 * 1024 + 1);
  expect(bytes([{ evidence: previouslyRejected }])).toBeGreaterThan(512 * 1024);
  expect(() => assertReviewEvidenceFitsPersistence(previouslyRejected)).not.toThrow();
});

test('the persisted entry cap is the schema’s own cap and is still a real bound', () => {
  expect(parseReviewEvidence(Array.from({ length: REVIEW_EVIDENCE_ENTRY_LIMIT }, entry))).toHaveLength(REVIEW_EVIDENCE_ENTRY_LIMIT);
  expect(() => parseReviewEvidence([...Array.from({ length: REVIEW_EVIDENCE_ENTRY_LIMIT }, entry), entry()])).toThrow();
});

test('trusted native key sequences retain every input under one final observation', () => {
  const observation = { ...entry(), action: 'key_batch', batch: {
    startedAt: '2026-09-27T00:00:00.000Z', finishedAt: '2026-09-27T00:00:01.000Z',
    steps: Array.from({ length: 512 }, (_, index) => ({ index, key: index === 511 ? 'Enter' : '1', waitMs: 0, success: true })),
  } };
  const persisted = parseReviewEvidence([observation]);
  expect(persisted).toEqual([observation]);
  expect(persisted[0].batch?.steps[511]).toEqual({ index: 511, key: 'Enter', waitMs: 0, success: true });
  expect(() => parseReviewEvidence([{ ...observation, batch: { ...observation.batch,
    steps: [...observation.batch.steps, { index: 512, key: 'Enter', waitMs: 0, success: true }],
  } }])).toThrow();
});

test('the storage backstop cannot be tighter than the application bound it protects', () => {
  // This is where the drift actually bit: a 512 KiB literal in the application
  // and a 512 KiB CHECK on the same record, measured differently, so an array
  // the application accepted could still die at the INSERT. PostgreSQL renders
  // jsonb with one space per separator, so jsonb::text is at most twice the
  // compact JSON the application measured; the migration's ceiling must
  // therefore be at least twice the application's bound. Measured on
  // PostgreSQL 17 with a maximal array: 2,097,152 compact -> 2,098,543 text.
  const migration = readFileSync(new URL('../../../../migrations/027_review_evidence_bytes.sql', import.meta.url), 'utf8');
  const bound = Number(/octet_length\(evidence_json::text\)\s*<=\s*(\d+)/.exec(migration)?.[1]);
  // The column stores the evidence array itself, whose application bound is
  // REVIEW_EVIDENCE_LIMIT_BYTES (the persistence payload is allowed the wrapper
  // on top), so twice that array bound is exactly the provable minimum.
  expect(bound).toBeGreaterThanOrEqual(2 * REVIEW_EVIDENCE_LIMIT_BYTES);
  expect(bound).toBeGreaterThan(REVIEW_EVIDENCE_PERSISTENCE_LIMIT_BYTES);
  expect(migration).toContain('checks_evidence_json_check');
});
