import { z } from "zod";
import { GroupIdSchema, type BehaviorTarget, type GroupedPlan } from "./planning.js";

const text = (max: number) => z.string().trim().min(1).max(max);
const sourceHash = z.string().regex(/^[a-f0-9]{64}$/);
export const CheckVerdictSchema = z.enum(["passed", "failed", "blocked"]);
export type CheckVerdict = z.infer<typeof CheckVerdictSchema>;
/** A grouped plan can contain 80 distinct targets, each needing its own post-action image. */
export const MAX_CHECK_ARTIFACTS = 80;

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
/** A screenshot can substitute for an action only when the sealed target asks
 * solely to inspect a rendered page. Ambiguous plans require interaction. */
export function allowsRenderOnlyEvidence(target: Pick<BehaviorTarget, "action">) {
  // An explicit instruction not to click or press any control still describes
  // observing the initial render. Strip only this terminal negative clause;
  // later positive actions must remain visible to the interaction guard.
  const action = target.action.trim().replace(/[，,]\s*(?:不点击任何按钮|不按(?:任何)?键)[。.]?$/u, "");
  const firstRender = /^(?:首次|初次)(?:加载|打开)(?:页面|界面)[。.]?$/u.test(action);
  const renderVerb = /(?:查看|观察|浏览|目视|阅读|检查|目测|打开|加载)/u.test(action);
  const renderedTarget = /(?:页面|界面|首屏|Canvas|画布|文本|文字|说明|按钮|输入框|控件|分数|最高分|区域|布局|结果|列表|标题)/iu.test(action);
  const renderOnly = firstRender
    || /^(?:直接)?(?:查看|观察|浏览|目视|阅读|打开页面|打开界面)|^(?:directly\s+)?(?:view|observe|inspect|look at|open\s+(?:the\s+)?(?:page|screen))/iu.test(action)
    || renderVerb && renderedTarget;
  // Waiting for page load is compatible with a first-render screenshot. Waiting
  // for gameplay is not. Viewport comparison is visual evidence: browser_resize
  // has no behaviorId, so the Reviewer must cite its observations and images.
  const timeAdvance = /(?:等待|持续|经过|一段时间|数秒|秒后|时间变化|自动运行)/u.test(action.replaceAll("等待页面加载完成", ""));
  const interaction = /(点击|按下|按键|按动|按住|按按钮|按(?:多个)?方向键|使用(?:键盘|方向键|空格)|输入(?!框)|填写|提交|选择(?!框)|切换|拖拽|滚动|刷新|重载|重启|发送|移动|控制|开始游戏|变化|更新|click|press|type|fill|submit|select|toggle|drag|scroll|reload|restart|send|move|control|start\s+(?:the\s+)?game)/iu.test(action);
  return renderOnly && !timeAdvance && !interaction;
}
const reviewItems = z.array(ReviewItemSchema).max(80)
  .refine((items) => new TextEncoder().encode(JSON.stringify(items)).length <= 64 * 1024, "检查条目不得超过 64 KiB。");

export const ReviewResultSchema = z.strictObject({
  revisionId: z.uuid(), sourceHash, items: reviewItems.min(1), summary: text(4000),
}).refine((result) => new Set(result.items.map((item) => item.behaviorId)).size === result.items.length, "检查目标不能重复。")
  // New submissions leave room for PostgreSQL JSONB's separators and escaping.
  // Stored Check reads retain their original 64 KiB item limit.
  .refine((result) => new TextEncoder().encode(JSON.stringify(result)).length <= 48 * 1024, "检查报告不得超过 48 KiB。");
export type ReviewResult = z.infer<typeof ReviewResultSchema>;

export const CheckGroupSchema = z.strictObject({
  id: GroupIdSchema, title: text(120), behaviorIds: z.array(ReviewItemSchema.shape.behaviorId).min(1).max(80),
  verdict: CheckVerdictSchema, requiredCount: z.number().int().min(1).max(80),
  passedCount: z.number().int().nonnegative(), failedCount: z.number().int().nonnegative(),
  blockedCount: z.number().int().nonnegative(),
}).superRefine((group, context) => {
  if (group.passedCount + group.failedCount + group.blockedCount !== group.behaviorIds.length
    || group.requiredCount > group.behaviorIds.length
    || group.verdict !== (group.blockedCount ? "blocked" : group.failedCount ? "failed" : "passed"))
    context.addIssue({ code: "custom", message: "检查组计数与结论不一致。" });
});
export type CheckGroup = z.infer<typeof CheckGroupSchema>;

/** The service derives group verdicts from every atomic result; the model never submits a 5/5 score. */
export function aggregateCheckGroups(plan: GroupedPlan, items: ReviewItem[]): CheckGroup[] {
  const expected = new Map(plan.behaviors.map((behavior) => [behavior.id, behavior]));
  const actual = new Map(items.map((item) => [item.behaviorId, item]));
  if (actual.size !== items.length || actual.size !== expected.size
    || items.some((item) => item.expected !== expected.get(item.behaviorId)?.expected))
    throw new Error("检查结果没有逐项对应完整计划。");
  return plan.groups.map((group) => {
    const children = group.behaviorIds.map((id) => actual.get(id));
    if (children.some((item) => !item)) throw new Error("检查组缺少子检查。");
    const passedCount = children.filter((item) => item?.verdict === "passed" && item.observationEventIds.length > 0).length;
    const failedCount = children.filter((item) => item?.verdict === "failed").length;
    const blockedCount = children.length - passedCount - failedCount;
    return CheckGroupSchema.parse({ id: group.id, title: group.title, behaviorIds: group.behaviorIds,
      verdict: blockedCount ? "blocked" : failedCount ? "failed" : "passed",
      requiredCount: group.behaviorIds.filter((id) => expected.get(id)?.required).length,
      passedCount, failedCount, blockedCount });
  });
}

/** Public artifact metadata contains no bucket key, download URL or credential. */
export const ReviewArtifactSchema = z.strictObject({ id: z.uuid(), mimeType: z.literal("image/png"), sha256: sourceHash });
export type ReviewArtifact = z.infer<typeof ReviewArtifactSchema>;
export const CheckArtifactSchema = ReviewArtifactSchema;
export type CheckArtifact = ReviewArtifact;

export const CheckSchema = ReviewBindingSchema.extend({
  id: z.uuid(), verdict: CheckVerdictSchema, items: reviewItems, summary: text(4000),
  artifacts: z.array(ReviewArtifactSchema).max(MAX_CHECK_ARTIFACTS), createdAt: z.iso.datetime(),
  // Absent on historical flat checks. New grouped checks are derived and saved by the service.
  groups: z.array(CheckGroupSchema).length(5).optional(),
}).superRefine((check, context) => {
  if (!check.groups) return;
  const ids = GroupIdSchema.options;
  const items = new Map(check.items.map((item) => [item.behaviorId, item]));
  const assigned = new Set<string>();
  for (const [index, group] of check.groups.entries()) {
    if (group.id !== ids[index]) context.addIssue({ code: "custom", message: "检查组 ID 顺序不正确。", path: ["groups", index] });
    for (const id of group.behaviorIds) {
      if (!items.has(id) || assigned.has(id))
        context.addIssue({ code: "custom", message: "子检查归属不完整或重复。", path: ["groups", index] });
      assigned.add(id);
    }
    const children = group.behaviorIds.map((id) => items.get(id));
    const passed = children.filter((item) => item?.verdict === "passed" && item.observationEventIds.length > 0).length;
    const failed = children.filter((item) => item?.verdict === "failed").length;
    const blocked = children.length - passed - failed;
    if (group.passedCount !== passed || group.failedCount !== failed || group.blockedCount !== blocked)
      context.addIssue({ code: "custom", message: "检查组结果与原始子项不一致。", path: ["groups", index] });
  }
  if (items.size !== check.items.length || assigned.size !== items.size)
    context.addIssue({ code: "custom", message: "检查结果缺少完整子项。", path: ["groups"] });
  if (check.verdict === "passed" && check.groups.some((group) => group.verdict !== "passed")
    || check.verdict === "failed" && !check.groups.some((group) => group.verdict === "failed"))
    context.addIssue({ code: "custom", message: "总结果与检查组结论不一致。", path: ["verdict"] });
});
export type Check = z.infer<typeof CheckSchema>;
export const RevisionCheckResponseSchema = z.object({ check: CheckSchema.nullable() });
export type RevisionCheckResponse = z.infer<typeof RevisionCheckResponseSchema>;
