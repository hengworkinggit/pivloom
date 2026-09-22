import { z } from "zod";

const text = (max: number) => z.string().trim().min(1).max(max);
const sourceHash = z.string().regex(/^[a-f0-9]{64}$/);
export const CheckVerdictSchema = z.enum(["passed", "failed", "blocked"]);
export type CheckVerdict = z.infer<typeof CheckVerdictSchema>;

/** Scope is supplied by the service, never by a model's submitted result. */
export const ReviewBindingSchema = z.strictObject({
  runId: z.uuid(), roleRunId: z.uuid(), attempt: z.number().int().min(0).max(2),
  revisionId: z.uuid(), sourceHash,
  sandboxId: text(128), browserSessionId: text(128),
});
export type ReviewBinding = z.infer<typeof ReviewBindingSchema>;

export const ReviewItemSchema = z.strictObject({
  behaviorId: z.string().regex(/^B(?:0[1-9]|[1-9]\d)$/), verdict: CheckVerdictSchema,
  expected: text(2000), actual: text(2000),
  // Browser observation UUIDs; these are not the decimal SSE event cursor.
  observationEventIds: z.array(z.uuid()).max(32),
  screenshotIds: z.array(z.uuid()).max(6), reproSteps: z.array(text(500)).max(8),
});
export type ReviewItem = z.infer<typeof ReviewItemSchema>;
const reviewItems = z.array(ReviewItemSchema).max(5)
  .refine((items) => new TextEncoder().encode(JSON.stringify(items)).length <= 64 * 1024, "检查条目不得超过 64 KiB。");

export const ReviewResultSchema = z.strictObject({
  revisionId: z.uuid(), sourceHash, items: reviewItems.min(1), summary: text(4000),
}).refine((result) => new Set(result.items.map((item) => item.behaviorId)).size === result.items.length, "检查目标不能重复。")
  // New submissions leave room for PostgreSQL JSONB's separators and escaping.
  // Stored Check reads retain their original 64 KiB item limit.
  .refine((result) => new TextEncoder().encode(JSON.stringify(result)).length <= 48 * 1024, "检查报告不得超过 48 KiB。");
export type ReviewResult = z.infer<typeof ReviewResultSchema>;

/** Public artifact metadata contains no bucket key, download URL or credential. */
export const ReviewArtifactSchema = z.strictObject({ id: z.uuid(), mimeType: z.literal("image/png"), sha256: sourceHash });
export type ReviewArtifact = z.infer<typeof ReviewArtifactSchema>;
export const CheckArtifactSchema = ReviewArtifactSchema;
export type CheckArtifact = ReviewArtifact;

export const CheckSchema = ReviewBindingSchema.extend({
  id: z.uuid(), verdict: CheckVerdictSchema, items: reviewItems, summary: text(4000),
  artifacts: z.array(ReviewArtifactSchema).max(6), createdAt: z.iso.datetime(),
});
export type Check = z.infer<typeof CheckSchema>;
export const RevisionCheckResponseSchema = z.object({ check: CheckSchema.nullable() });
export type RevisionCheckResponse = z.infer<typeof RevisionCheckResponseSchema>;
