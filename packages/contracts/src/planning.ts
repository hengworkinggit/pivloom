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
/**
 * Replay operations a plan can carry. Controls are addressed by accessible role
 * and name because nothing else survives from planning to replay: a runtime ref
 * (`e123`) is minted per observation, and a CSS selector or coordinate binds the
 * plan to markup the Builder is still free to change. This mirrors the
 * Reviewer's browser_steps steps (apps/api/src/runtime/reviewer.ts) without the
 * runtime-only fields (observationId, ref, behaviorIds, capture).
 */
const planControl = { role: nonempty(80).default("button"), name: nonempty(300) };
/**
 * The browser CLI recognizes exactly these keys (BrowserPressKeySchema in
 * apps/api/src/runtime/browser.ts). The list is duplicated because the contract
 * package cannot import the API package; an unsupported key is refused here for
 * one correction turn instead of failing a replay after the browser started.
 */
const planPressKey = z.enum(["Enter", "Backspace", "Tab", "Escape", "ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Space",
  "0", "1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "+", "-", "*", "/", "(", ")"]);
/**
 * The Reviewer's browser_steps kernel already runs at most 64 steps in one
 * call, so a compiled behavior never needs a longer program than the executor
 * that exists. The plan byte cap, not this array, is what binds in practice: a
 * compiled 41-behavior plan spends roughly 1 KiB per behavior on steps alone.
 */
export const MAX_BEHAVIOR_STEPS = 64;
/** A behavior needing more than a dozen script checks is several behaviors. */
export const MAX_BEHAVIOR_ASSERTIONS = 16;
export const BehaviorStepSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("open"), path: nonempty(500).default("/") }),
  z.strictObject({ type: z.literal("reload") }),
  z.strictObject({ type: z.literal("resize"), width: z.number().int().min(320).max(2560), height: z.number().int().min(320).max(2000) }),
  z.strictObject({ type: z.literal("click"), ...planControl }),
  z.strictObject({ type: z.literal("fill"), ...planControl, text: z.string().max(2000) }),
  z.strictObject({ type: z.literal("select"), ...planControl, value: z.string().max(2000) }),
  z.strictObject({ type: z.literal("press"), key: planPressKey }),
  z.strictObject({ type: z.literal("wait"), ms: z.number().int().min(1).max(3000) }),
  // A marker, not a model request: the replay records where an image is taken
  // so that an evidence:"visual" behavior has an artifact to hand to a model.
  z.strictObject({ type: z.literal("capture") }),
]);
export type BehaviorStep = z.infer<typeof BehaviorStepSchema>;
/**
 * v1 decides only what BrowserObservation plus logs() already return: page text,
 * the observation's role/name table of controls, and console output. `negated`
 * flips the predicate instead of doubling the kind list, so one evaluator covers
 * both "the message appears" and "the error is gone". Kinds that need a rendered
 * judgement (colour, overflow, canvas) are evidence "visual" and go to a model;
 * they must not pretend to be script-decidable assertions.
 */
const negated = z.boolean().default(false);
export const BehaviorAssertionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("text"), text: nonempty(500), negated }),
  z.strictObject({ kind: z.literal("control"), ...planControl, negated }),
  z.strictObject({ kind: z.literal("console-error"), negated }),
]);
export type BehaviorAssertion = z.infer<typeof BehaviorAssertionSchema>;
export const BehaviorEvidenceSchema = z.enum(["text", "visual"]);
export type BehaviorEvidence = z.infer<typeof BehaviorEvidenceSchema>;
export const BehaviorTargetSchema = z.strictObject({
  id: z.string().regex(/^B(?:0[1-9]|[1-9]\d)$/),
  title: nonempty(120), precondition: nonempty(500), action: nonempty(500), expected: nonempty(500), required: z.boolean(),
  // Optional so every plan written before the replay existed — and every
  // behavior no script can drive — still validates, and is simply treated as
  // not-compilable by the replay instead of failing the whole plan.
  steps: z.array(BehaviorStepSchema).max(MAX_BEHAVIOR_STEPS).optional(),
  assertions: z.array(BehaviorAssertionSchema).max(MAX_BEHAVIOR_ASSERTIONS).optional(),
  // Absent means unchanged for callers that predate executable verification.
  evidence: BehaviorEvidenceSchema.optional(),
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
})
  // Executable steps and assertions cost roughly 1 KiB per behavior on top of
  // prose, so a compiled 41-behavior plan passes the old 64 KiB ceiling and a
  // maximal 80-behavior one does not. 96 KiB is the largest raise that still
  // leaves the 160 KiB HandoffSchema at least 64 KiB for its task text; the
  // bound stays 1.5x rather than doubling so plan bloat still fails loudly.
  .refine(boundedJson(96 * 1024), "五组计划不得超过 96 KiB。");
export const PlanSchema = z.discriminatedUnion("schemaVersion", [LegacyPlanSchema, GroupedPlanSchema]);
export type Plan = z.infer<typeof PlanSchema>;
export type GroupedPlan = z.infer<typeof GroupedPlanSchema>;
/**
 * The observable contract of a preserved behavior, compared without cosmetic
 * differences. Models reliably re-wrap lines and swap punctuation, which says
 * nothing about the behavior, while any real rewording of the expected result
 * still has to be reproduced exactly.
 *
 * Two classes of field are deliberately treated differently. precondition,
 * action, expected and required are what the user was promised, so changing any
 * of them is a redefinition and must go through an explicit replacement record.
 * steps, assertions and evidence are only how that promise is verified: a later
 * increment that compiles a prose behavior into steps, or sharpens an assertion,
 * makes verification more precise while the promised behavior stays identical,
 * so it must not be rejected — otherwise every attempt to speed up verification
 * would retire a behavior the user never changed, and the plan would be forced
 * into a bogus replacement. The prose fields stay authoritative: a change may
 * not weaken expected and "compensate" with a stricter assertion.
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
/**
 * A cosmetic title change is allowed; every old required observable contract
 * remains intact. Executable verification is not part of that contract, so it
 * may be added or refined freely (see sameObservableBehavior).
 */
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
