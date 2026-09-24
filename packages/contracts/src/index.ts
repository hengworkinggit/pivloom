import { z } from "zod";
import { ProjectMessageSchema, RunSchema, RevisionSchema, PreviewSchema, ProjectQuotaSchema } from "./generation.js";
import { CheckSchema } from "./review.js";
export * from "./models.js";
export * from "./generation.js";
export * from "./planning.js";
export * from "./review.js";

export const ProjectSummarySchema = z.object({
  id: z.uuid(),
  title: z.string().min(1).max(120),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  currentRevisionId: z.uuid().nullable(),
  /**
   * What the project is doing right now, so a list card can tell a task waiting
   * for capacity apart from a task that is really executing. Null when the
   * project has no open task. `activeRunPosition` is only ever a real scheduler
   * position: null for a task that is not waiting, and null for one that is
   * blocked behind its own project and so not yet competing for a slot.
   */
  activeRunState: z.enum(["queued", "accepted", "planning", "building", "verifying", "repairing", "finalizing", "cancel_requested"]).nullable().default(null),
  activeRunPosition: z.number().int().positive().nullable().default(null),
});
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;

export const CreateProjectRequestSchema = z.strictObject({
  title: z.string().trim().min(1).max(120).optional(),
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>;
export const CreateProjectResponseSchema = z.object({ project: ProjectSummarySchema });
export const ProjectListResponseSchema = z.object({
  projects: z.array(ProjectSummarySchema),
  nextCursor: z.string().nullable(),
});
export type ProjectListResponse = z.infer<typeof ProjectListResponseSchema>;

export const ProjectDetailResponseSchema = z.object({
  project: ProjectSummarySchema,
  messages: z.array(ProjectMessageSchema),
  currentRevision: RevisionSchema.nullable(),
  activeRun: RunSchema.nullable(),
  latestRun: RunSchema.nullable().default(null),
  latestCandidate: RevisionSchema.nullable().default(null),
  latestCheck: CheckSchema.nullable().default(null),
  // An accepted revision restored by rollback carries its original Check. No
  // new browser verification is implied by rebuilding the Preview.
  latestCheckHistorical: z.boolean().optional(),
  preview: PreviewSchema.nullable(),
  // Optional so older stored snapshots and test fixtures stay valid.
  quota: ProjectQuotaSchema.nullish(),
});
export type ProjectDetailResponse = z.infer<typeof ProjectDetailResponseSchema>;

export const MeResponseSchema = z.object({
  user: z.object({ id: z.uuid(), name: z.string(), email: z.string().email() }),
});
export type MeResponse = z.infer<typeof MeResponseSchema>;

export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    requestId: z.string(),
  }),
});
export type ApiErrorResponse = z.infer<typeof ApiErrorSchema>;
