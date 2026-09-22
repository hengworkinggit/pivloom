import { z } from "zod";
import { ClarificationSchema, PlanSchema, RoleRunSchema } from "./planning.js";

export const RunStateSchema = z.enum([
  "accepted", "planning", "building", "verifying", "repairing", "finalizing",
  "cancel_requested", "completed", "needs_changes", "needs_input", "failed", "cancelled", "interrupted",
]);
export type RunState = z.infer<typeof RunStateSchema>;
export const RunPhaseSchema = z.enum(["plan", "provision", "implement", "build", "snapshot", "review", "persist", "cleanup"]);
export type RunPhase = z.infer<typeof RunPhaseSchema>;
export const TerminalRunStates: ReadonlySet<RunState> = new Set([
  "completed", "needs_changes", "needs_input", "failed", "cancelled", "interrupted",
]);

export const CreateRunRequestSchema = z.strictObject({
  text: z.string().trim().min(1).max(8000),
  expectedCurrentRevisionId: z.uuid().nullable(),
  modelProfileId: z.uuid(),
  modelConfigVersion: z.number().int().positive(),
  // A run may pin a different catalog model under the same provider credential
  // than its default. Omitted/null means "use the profile's default model".
  modelId: z.string().trim().min(1).max(160).nullish(),
  retryOfRunId: z.uuid().nullable().default(null),
  parentRunId: z.uuid().nullable().default(null),
}).refine((value) => !(value.retryOfRunId && value.parentRunId), "重试与澄清不能同时提交。");
export type CreateRunRequest = z.infer<typeof CreateRunRequestSchema>;

export const RunErrorSchema = z.object({
  code: z.string().max(80), message: z.string().max(2000), retryable: z.boolean(),
});
export const RunSchema = z.object({
  id: z.uuid(), projectId: z.uuid(), state: RunStateSchema, phase: RunPhaseSchema,
  attempt: z.number().int().min(0).max(2), requestText: z.string().max(8000),
  modelProfileId: z.uuid(), modelConfigVersion: z.number().int().positive(),
  // The exact model this run used; null means the profile's default model.
  modelId: z.string().max(160).nullable().default(null),
  baseRevisionId: z.uuid().nullable(), resultRevisionId: z.uuid().nullable(),
  createdAt: z.iso.datetime(), deadlineAt: z.iso.datetime(), finishedAt: z.iso.datetime().nullable(),
  cleanupState: z.enum(["clear", "pending", "confirmed"]),
  error: RunErrorSchema.nullable(), summary: z.string().max(4000).nullable(),
  plan: PlanSchema.nullable().optional(), clarification: ClarificationSchema.nullable().optional(), parentRunId: z.uuid().nullable().optional(),
});
export type Run = z.infer<typeof RunSchema>;
export const CreateRunResponseSchema = z.object({
  runId: z.uuid(), state: RunStateSchema, eventsUrl: z.string(), replayed: z.boolean(),
});
export type CreateRunResponse = z.infer<typeof CreateRunResponseSchema>;

export const ProjectMessageSchema = z.object({
  id: z.uuid(), projectId: z.uuid(), runId: z.uuid(), kind: z.enum(["user", "result", "question"]),
  content: z.string().max(8000), createdAt: z.iso.datetime(),
});
export type ProjectMessage = z.infer<typeof ProjectMessageSchema>;
export const SourceFileInfoSchema = z.object({
  path: z.string().min(1).max(240), bytes: z.number().int().min(0).max(512 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type SourceFileInfo = z.infer<typeof SourceFileInfoSchema>;
export const RevisionSchema = z.object({
  id: z.uuid(), projectId: z.uuid(), runId: z.uuid(), revisionNo: z.number().int().positive(),
  attempt: z.number().int().min(0).max(2), sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  templateVersion: z.string(), buildStatus: z.enum(["passed", "failed"]),
  status: z.enum(["candidate", "accepted", "rejected"]),
  createdAt: z.iso.datetime(), manifest: z.array(SourceFileInfoSchema).max(200),
});
export type Revision = z.infer<typeof RevisionSchema>;
export const PreviewSchema = z.object({
  state: z.enum(["ready", "expired", "unavailable", "restoring"]),
  revisionId: z.uuid(), sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  url: z.url().nullable(), expiresAt: z.iso.datetime().nullable(), error: z.string().max(2000).nullable(),
});
export type Preview = z.infer<typeof PreviewSchema>;

export const RunEventTypeSchema = z.enum([
  "run.accepted", "run.phase", "role.started", "role.completed", "tool.started", "tool.output",
  "tool.completed", "revision.saved", "preview.ready", "check.completed", "run.cancel_requested", "run.finished",
]);
export type RunEventType = z.infer<typeof RunEventTypeSchema>;
export const RunEventSchema = z.object({
  schemaVersion: z.literal(1), eventId: z.string().regex(/^\d+$/), runId: z.uuid(),
  roleRunId: z.uuid().nullable().optional(), attempt: z.number().int().min(0).max(2),
  type: RunEventTypeSchema, createdAt: z.iso.datetime(), payload: z.record(z.string(), z.unknown()),
});
export type RunEvent = z.infer<typeof RunEventSchema>;
export const RunDetailResponseSchema = z.object({
  run: RunSchema, revision: RevisionSchema.nullable(), events: z.array(RunEventSchema), preview: PreviewSchema.nullable(),
  roles: z.array(RoleRunSchema).default([]),
});
export type RunDetailResponse = z.infer<typeof RunDetailResponseSchema>;
export const RevisionFilesResponseSchema = z.object({
  revisionId: z.uuid(), sourceHash: z.string().regex(/^[a-f0-9]{64}$/), files: z.array(SourceFileInfoSchema),
});
export const RevisionFileResponseSchema = z.object({
  revisionId: z.uuid(), path: z.string(), content: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export const PreviewResponseSchema = z.object({ preview: PreviewSchema.nullable() });

export const CancelRunResponseSchema = z.object({
  runId: z.uuid(),
  state: RunStateSchema,
  phase: RunPhaseSchema,
  cleanupState: z.enum(["clear", "pending", "confirmed"]),
});
export type CancelRunResponse = z.infer<typeof CancelRunResponseSchema>;

export const RestorePreviewRequestSchema = z.strictObject({
  revisionId: z.uuid(),
});
export type RestorePreviewRequest = z.infer<typeof RestorePreviewRequestSchema>;

export const RestorePreviewResponseSchema = z.object({
  operationId: z.uuid(),
  preview: PreviewSchema,
});
export type RestorePreviewResponse = z.infer<typeof RestorePreviewResponseSchema>;

export const ProjectQuotaSchema = z.object({
  dailyLimit: z.number().int().nonnegative(),
  dailyAccepted: z.number().int().nonnegative(),
});
export type ProjectQuota = z.infer<typeof ProjectQuotaSchema>;
