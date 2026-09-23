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
export const LegacyPlanSchema = z.strictObject({
  schemaVersion: z.literal(1), goal: nonempty(1000), changeSummary: nonempty(1000),
  assumptions: z.array(nonempty(300)).max(5), outOfScope: z.array(nonempty(300)).max(5),
  behaviors: z.array(BehaviorTargetSchema).min(1).max(5),
}).refine((plan) => new Set(plan.behaviors.map((behavior) => behavior.id)).size === plan.behaviors.length, "行为 ID 必须唯一。")
  .refine(boundedJson(16 * 1024), "计划不得超过 16 KiB。");
export const GroupIdSchema = z.enum(["G1", "G2", "G3", "G4", "G5"]);
export const BehaviorGroupSchema = z.strictObject({
  id: GroupIdSchema, title: nonempty(120),
  behaviorIds: z.array(BehaviorTargetSchema.shape.id).min(1).max(80),
});
export const GroupedPlanSchema = z.strictObject({
  schemaVersion: z.literal(2), goal: nonempty(1000), changeSummary: nonempty(1000),
  assumptions: z.array(nonempty(300)).max(5), outOfScope: z.array(nonempty(300)).max(5),
  behaviors: z.array(BehaviorTargetSchema).min(5).max(80),
  groups: z.array(BehaviorGroupSchema).length(5),
  replacements: z.array(z.strictObject({ oldBehaviorId: BehaviorTargetSchema.shape.id,
    newBehaviorId: BehaviorTargetSchema.shape.id, userRequestQuote: nonempty(500), reason: nonempty(500) })).max(80).default([]),
}).superRefine((plan, context) => {
  const behaviorIds = new Set(plan.behaviors.map((behavior) => behavior.id));
  if (behaviorIds.size !== plan.behaviors.length)
    context.addIssue({ code: "custom", message: "行为 ID 必须唯一。", path: ["behaviors"] });
  const assigned = new Set<string>();
  const orderedIds = GroupIdSchema.options;
  for (const [index, group] of plan.groups.entries()) {
    if (group.id !== orderedIds[index])
      context.addIssue({ code: "custom", message: "五个组必须按稳定 ID 排列。", path: ["groups", index, "id"] });
    for (const id of group.behaviorIds) {
      if (!behaviorIds.has(id) || assigned.has(id))
        context.addIssue({ code: "custom", message: "每个子检查必须且只能归属一个组。", path: ["groups", index, "behaviorIds"] });
      assigned.add(id);
    }
    if (!group.behaviorIds.some((id) => plan.behaviors.some((behavior) => behavior.id === id && behavior.required)))
      context.addIssue({ code: "custom", message: "每组至少包含一个必需子检查。", path: ["groups", index] });
  }
  if (assigned.size !== behaviorIds.size)
    context.addIssue({ code: "custom", message: "所有子检查都必须归组。", path: ["groups"] });
  const replaced = new Set<string>(), incoming = new Set<string>();
  const replacementByOld = new Map(plan.replacements.map((item) => [item.oldBehaviorId, item]));
  const reachesCurrent = (id: string, seen = new Set<string>()): boolean => {
    if (behaviorIds.has(id)) return true;
    if (seen.has(id)) return false;
    const next = replacementByOld.get(id);
    return next ? reachesCurrent(next.newBehaviorId, new Set([...seen, id])) : false;
  };
  for (const [index, item] of plan.replacements.entries()) {
    if (replaced.has(item.oldBehaviorId) || incoming.has(item.newBehaviorId) || item.oldBehaviorId === item.newBehaviorId
      || behaviorIds.has(item.oldBehaviorId) || !reachesCurrent(item.newBehaviorId))
      context.addIssue({ code: "custom", message: "替代关系必须由旧 ID 指向一个新的子检查 ID。", path: ["replacements", index] });
    replaced.add(item.oldBehaviorId); incoming.add(item.newBehaviorId);
  }
}).refine(boundedJson(64 * 1024), "五组计划不得超过 64 KiB。");
export const PlanSchema = z.discriminatedUnion("schemaVersion", [LegacyPlanSchema, GroupedPlanSchema]);
export type Plan = z.infer<typeof PlanSchema>;
export type GroupedPlan = z.infer<typeof GroupedPlanSchema>;
/**
 * The observable contract of a preserved behavior, compared without cosmetic
 * differences. Models reliably re-wrap lines and swap punctuation, which says
 * nothing about the behavior, while any real rewording of the expected result
 * still has to be reproduced exactly.
 */
function observable(value: string) {
  return value.replace(/\s+/gu, " ").trim().replace(/[。．.,，;；:：!！?？]+$/u, "");
}
export function sameObservableBehavior(left: BehaviorTarget, right: BehaviorTarget) {
  return left.id === right.id && left.required === right.required
    && observable(left.precondition) === observable(right.precondition)
    && observable(left.action) === observable(right.action)
    && observable(left.expected) === observable(right.expected);
}
/** A cosmetic title change is allowed; every old required observable contract remains intact. */
export function preservesPreviousBehavior(plan: Plan, previousPlan: Plan | null, userRequest = "") {
  if (!previousPlan) return plan.schemaVersion !== 2 || plan.replacements.length === 0;
  if (previousPlan.schemaVersion === 2 && plan.schemaVersion !== 2) return false;
  if (previousPlan.schemaVersion === 2 && plan.schemaVersion === 2
    && previousPlan.groups.some((group) => observable(group.title) !== observable(plan.groups.find((item) => item.id === group.id)?.title ?? ""))) return false;
  const previousIds = new Set(previousPlan.behaviors.map((behavior) => behavior.id));
  const groupOf = (value: GroupedPlan, id: string) => value.groups.find((group) => group.behaviorIds.includes(id))?.id;
  const inherited = previousPlan.schemaVersion === 2 ? previousPlan.replacements : [];
  if (plan.schemaVersion === 2) for (const prior of inherited) {
    const current = plan.replacements.find((item) => item.oldBehaviorId === prior.oldBehaviorId);
    if (!current || JSON.stringify(current) !== JSON.stringify(prior)) return false;
  }
  if (plan.schemaVersion === 2) for (const replacement of plan.replacements) {
    if (inherited.some((prior) => prior.oldBehaviorId === replacement.oldBehaviorId)) continue;
    const previous = previousPlan.behaviors.find((behavior) => behavior.id === replacement.oldBehaviorId);
    const incoming = plan.behaviors.find((behavior) => behavior.id === replacement.newBehaviorId);
    const quote = replacement.userRequestQuote.replace(/\s+/gu, " ").trim();
    if (!previous || !incoming || previousIds.has(incoming.id) || incoming.required !== previous.required || quote.length < 4
      || !userRequest.replace(/\s+/gu, " ").toLowerCase().includes(quote.toLowerCase())
      || !/(改为|改成|改用|修改|替换|取消|删除|不要|instead|replace|remove|drop)/iu.test(quote)
      || previousPlan.schemaVersion === 2 && groupOf(plan, incoming.id) !== groupOf(previousPlan, previous.id)) return false;
  }
  for (const previous of previousPlan.behaviors) {
    const candidate = plan.behaviors.find((behavior) => behavior.id === previous.id);
    if (candidate) {
      if (!sameObservableBehavior(candidate, previous)) return false;
      if (previousPlan.schemaVersion === 2 && plan.schemaVersion === 2
        && groupOf(plan, candidate.id) !== groupOf(previousPlan, previous.id)) return false;
      continue;
    }
    if (!previous.required) continue;
    if (plan.schemaVersion !== 2 || !plan.replacements.some((item) => item.oldBehaviorId === previous.id)) return false;
  }
  return true;
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
}).refine(boundedJson(128 * 1024), "需求上下文不得超过 128 KiB。");
export type PlanningContext = z.infer<typeof PlanningContextSchema>;
export const HandoffSchema = z.strictObject({
  runId: z.uuid(), fromRoleRunId: z.uuid().nullable(), toRole: RoleSchema,
  attempt: z.number().int().min(0).max(2), baseRevisionId: z.uuid().nullable(), expectedRevisionId: z.uuid().nullable(),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(), plan: PlanSchema, task: nonempty(64_000),
  failedChecks: z.array(nonempty(1000)).max(80).optional(), artifactIds: z.array(z.uuid()).max(20),
}).refine(boundedJson(160 * 1024), "交接内容不得超过 160 KiB。");
export type Handoff = z.infer<typeof HandoffSchema>;
export const RoleRunSchema = z.object({
  id: z.uuid(), runId: z.uuid(), role: RoleSchema, attempt: z.number().int().min(0).max(2), sessionId: z.uuid(),
  state: z.enum(["queued", "running", "succeeded", "failed", "cancelled", "interrupted"]), predecessorId: z.uuid().nullable(),
  startedAt: z.iso.datetime().nullable(), finishedAt: z.iso.datetime().nullable(),
});
export type RoleRun = z.infer<typeof RoleRunSchema>;
