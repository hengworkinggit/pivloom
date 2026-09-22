import { z } from "zod";

const nonempty = (max: number) => z.string().trim().min(1).max(max);
const boundedJson = (maxBytes: number) => (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length <= maxBytes;
export const RoleSchema = z.enum(["coordinator", "builder", "reviewer"]);
export type Role = z.infer<typeof RoleSchema>;
const counter = z.number().int().nonnegative();
export const RoleUsageSchema = z.strictObject({
  modelCalls: counter, toolCalls: counter,
  inputTokens: counter.nullable(), outputTokens: counter.nullable(), cachedTokens: counter.nullable(),
  elapsedMs: z.number().nonnegative(), source: z.enum(["reported", "partial", "unreported"]),
  totalTokens: counter.nullable().optional(),
}).refine((usage) => {
  const tokens = [usage.inputTokens, usage.outputTokens, usage.cachedTokens, ...(usage.totalTokens === undefined ? [] : [usage.totalTokens])];
  const source = tokens.every((value) => value === null) ? "unreported" : tokens.every((value) => value !== null) ? "reported" : "partial";
  return usage.source === source;
}, "用量来源必须明确反映供应商字段的已知程度。");
export type RoleUsage = z.infer<typeof RoleUsageSchema>;
export const BehaviorTargetSchema = z.strictObject({
  id: z.string().regex(/^B(?:0[1-9]|[1-9]\d)$/),
  title: nonempty(120), precondition: nonempty(500), action: nonempty(500), expected: nonempty(500), required: z.boolean(),
});
export type BehaviorTarget = z.infer<typeof BehaviorTargetSchema>;
export const PlanSchema = z.strictObject({
  schemaVersion: z.literal(1), goal: nonempty(1000), changeSummary: nonempty(1000),
  assumptions: z.array(nonempty(300)).max(5), outOfScope: z.array(nonempty(300)).max(5),
  behaviors: z.array(BehaviorTargetSchema).min(1).max(5),
}).refine((plan) => new Set(plan.behaviors.map((behavior) => behavior.id)).size === plan.behaviors.length, "行为 ID 必须唯一。")
  .refine(boundedJson(16 * 1024), "计划不得超过 16 KiB。");
export type Plan = z.infer<typeof PlanSchema>;
/** A cosmetic title change is allowed; the original observable contract remains intact. */
export function preservesPreviousBehavior(plan: Plan, previousPlan: Plan | null) {
  return !previousPlan || plan.behaviors.some((candidate) => previousPlan.behaviors.some((previous) =>
    previous.id === candidate.id && previous.precondition === candidate.precondition && previous.action === candidate.action
    && previous.expected === candidate.expected && previous.required === candidate.required));
}
export const ClarificationQuestionSchema = nonempty(1000);
const newClarificationQuestion = nonempty(300)
  .refine((question) => !/[\r\n\u2028\u2029]/u.test(question), "只允许一个单行关键问题。")
  .refine((question) => !/[?？]./u.test(question), "最多允许一个问号，且只能位于末尾。")
  .refine((question) => !/(?:^|[\s:：;；])(?:[-*+]\s+|[•●▪◦‣]\s*|(?:\d{1,2}(?:[、．]|[.)](?!\d))|[（(]\d{1,2}[）)]|[一二三四五六七八九十][、．.)])\s*)|[①-⑳]/u.test(question), "关键问题不能包含编号或项目列表。");
export const ClarificationRequestSchema = z.strictObject({ question: newClarificationQuestion });
export type ClarificationRequest = z.infer<typeof ClarificationRequestSchema>;
export const ClarificationSchema = z.strictObject({ question: ClarificationQuestionSchema });
export type Clarification = z.infer<typeof ClarificationSchema>;
const requestText = z.string().min(1).max(8000).refine((text) => text.trim().length > 0, "需求不能为空。");
export const PlanningContextSchema = z.strictObject({
  schemaVersion: z.literal(1), project: z.strictObject({ id: z.uuid(), title: nonempty(120) }),
  requestText, originalRequest: requestText,
  clarificationTurns: z.array(z.strictObject({ parentRunId: z.uuid(), question: ClarificationQuestionSchema, answer: requestText })).max(8),
  baseRevisionId: z.uuid().nullable(), previousPlan: PlanSchema.nullable(),
}).refine(boundedJson(64 * 1024), "需求上下文不得超过 64 KiB。");
export type PlanningContext = z.infer<typeof PlanningContextSchema>;
export const HandoffSchema = z.strictObject({
  runId: z.uuid(), fromRoleRunId: z.uuid().nullable(), toRole: RoleSchema,
  attempt: z.number().int().min(0).max(2), baseRevisionId: z.uuid().nullable(), expectedRevisionId: z.uuid().nullable(),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(), plan: PlanSchema, task: nonempty(64_000),
  failedChecks: z.array(nonempty(1000)).max(5).optional(), artifactIds: z.array(z.uuid()).max(20),
}).refine(boundedJson(96 * 1024), "交接内容不得超过 96 KiB。");
export type Handoff = z.infer<typeof HandoffSchema>;
export const RoleRunSchema = z.object({
  id: z.uuid(), runId: z.uuid(), role: RoleSchema, attempt: z.number().int().min(0).max(2), sessionId: z.uuid(),
  state: z.enum(["queued", "running", "succeeded", "failed", "cancelled", "interrupted"]), predecessorId: z.uuid().nullable(),
  startedAt: z.iso.datetime().nullable(), finishedAt: z.iso.datetime().nullable(),
});
export type RoleRun = z.infer<typeof RoleRunSchema>;
