import { z } from "zod";
import { ProjectMessageSchema, RunSchema, RevisionSchema, PreviewSchema } from "./generation.js";
export * from "./models.js";
export * from "./generation.js";
export * from "./planning.js";

export const ProjectSummarySchema = z.object({
  id: z.uuid(),
  title: z.string().min(1).max(120),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  currentRevisionId: z.uuid().nullable(),
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
  preview: PreviewSchema.nullable(),
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
