"use client";

import { LoaderCircle, TriangleAlert } from "lucide-react";
import { TerminalRunStates, type Check, type RoleRun, type Run, type RunEvent, type RunPhase } from "@pivloom/contracts";
import { LoomMark } from "./brand";
import { GenerationPlan } from "./generation-plan";
import { useUiPreferences, type Locale } from "@/lib/ui-preferences";

const phaseLabels: Record<RunPhase, string> = {
  plan: "正在整理需求", provision: "正在准备构建环境", implement: "正在编写应用",
  build: "正在检查与构建", snapshot: "正在保存源码快照", review: "正在检查关键流程",
  persist: "正在保存结果", cleanup: "正在清理执行资源",
};
const eventLabels: Partial<Record<RunEvent["type"], string>> = {
  "run.accepted": "需求已接收", "role.started": "开始执行", "role.completed": "执行结束",
  "tool.started": "调用工具", "tool.completed": "工具执行结束", "revision.saved": "源码快照已保存",
  "preview.ready": "预览已就绪", "check.completed": "检查结果已记录", "run.finished": "任务已结束",
};
const textValue = (value: unknown) => typeof value === "string" ? value : "";
const roleLabels: Record<RoleRun["role"], string> = { coordinator: "协调者", builder: "工程师", reviewer: "检查者" };
const roleStateLabels: Record<RoleRun["state"], string> = { queued: "等待开始", running: "执行中", succeeded: "已完成", failed: "未完成", cancelled: "已停止", interrupted: "已中断" };
const phaseLabelsEn: Record<RunPhase, string> = { plan: "Planning", provision: "Preparing workspace", implement: "Building app", build: "Checking build", snapshot: "Saving source", review: "Checking key flows", persist: "Saving result", cleanup: "Cleaning up" };
const eventLabelsEn: Partial<Record<RunEvent["type"], string>> = { "run.accepted": "Request accepted", "role.started": "Started", "role.completed": "Finished", "tool.started": "Tool call", "tool.completed": "Tool finished", "revision.saved": "Source saved", "preview.ready": "Preview ready", "check.completed": "Check recorded", "run.finished": "Run finished" };
const roleLabelsEn: Record<RoleRun["role"], string> = { coordinator: "Coordinator", builder: "Builder", reviewer: "Reviewer" };
const roleStateLabelsEn: Record<RoleRun["state"], string> = { queued: "Queued", running: "Running", succeeded: "Complete", failed: "Incomplete", cancelled: "Stopped", interrupted: "Interrupted" };
function describe(event: RunEvent, locale: Locale) {
  const phase = textValue(event.payload.phase);
  if (event.type === "run.phase") {
    if (phase === "cleanup" && event.payload.cleanupState === "confirmed") return locale === "en" ? "Resources cleaned up" : "资源清理已确认";
    return phase in phaseLabels ? (locale === "en" ? phaseLabelsEn : phaseLabels)[phase as RunPhase] : locale === "en" ? "Phase updated" : "执行阶段更新";
  }
  const role = textValue(event.payload.role);
  const detail = textValue(event.payload.toolName) || textValue(event.payload.tool) || (role in roleLabels ? (locale === "en" ? roleLabelsEn : roleLabels)[role as RoleRun["role"]] : role);
  return [(locale === "en" ? eventLabelsEn : eventLabels)[event.type] ?? (locale === "en" ? "Run updated" : "执行状态更新"), detail].filter(Boolean).join(" · ");
}

export function GenerationActivity({ run, events, roles = [] }: { run: Run; events: RunEvent[]; roles?: RoleRun[] }) {
  const ui = useUiPreferences();
  // A queued task is not executing: it holds no sandbox and no role is working,
  // so it must not render as "处理中" with a spinner above the composer.
  const queued = run.state === "queued";
  const active = !queued && !TerminalRunStates.has(run.state);
  const visible = events.filter((event) => event.runId === run.id);
  const latest = visible.filter((event) => event.type !== "tool.output").slice(-4);
  return <article className="assistant-message active-message" data-testid="role-timeline">
    <div className="assistant-message-heading"><LoomMark /><strong>Pivloom</strong><span>{queued ? ui.text("排队中", "Queued") : active ? ui.text("处理中", "Working") : ui.text("任务记录", "Run activity")}</span></div>
    <div className="assistant-message-body">
      <p className="run-label" role="status">{active && <LoaderCircle className="spin" size={13} />}{queued ? ui.text("已排队，资源可用后自动开始", "Queued; it starts as soon as capacity is free") : run.state === "accepted" ? ui.text("需求已接收", "Request accepted") : active ? (ui.locale === "en" ? phaseLabelsEn : phaseLabels)[run.phase] : ui.text("本次任务已结束", "Run finished")}</p>
      <p className="generation-run-model">{ui.text("模型配置", "Model config")} v{run.modelConfigVersion}{run.modelId ? ` · ${run.modelId}` : ""} · {ui.text("任务", "Run")} {run.id.slice(0, 8)}</p>
      {roles.length > 0 && <ul className="generation-role-activity" data-testid="role-activity" aria-label={ui.text("实际角色活动", "Role activity")}>{roles.filter((role) => role.runId === run.id).map((role) => <li key={role.id}>
        <strong>{(ui.locale === "en" ? roleLabelsEn : roleLabels)[role.role]}</strong><span>{(ui.locale === "en" ? roleStateLabelsEn : roleStateLabels)[role.state]}</span>
      </li>)}</ul>}
      {run.plan && <GenerationPlan plan={run.plan} />}
      {latest.length > 0 && <ul className="generation-activity-list">{latest.map((event) => <li key={event.eventId}>{describe(event, ui.locale)}</li>)}</ul>}
      {visible.length > 0 && <details className="generation-event-log"><summary>{ui.text("查看真实执行记录", "View activity log")} <span>{visible.length}</span></summary>
        <ol>{visible.map((event) => <li key={event.eventId}><strong>{describe(event, ui.locale)}</strong><time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleTimeString(ui.locale === "en" ? "en-US" : "zh-CN", { hour12: false })}</time>
          {event.type === "tool.output" && <pre>{(textValue(event.payload.output) || textValue(event.payload.text) || textValue(event.payload.message)).slice(0, 8000) || ui.text("工具输出已记录", "Tool output recorded")}</pre>}
        </li>)}</ol>
      </details>}
    </div>
  </article>;
}

export function GenerationOutcome({ run, candidateSaved, check }: { run: Run; candidateSaved: boolean; check?: Check | null }) {
  const ui = useUiPreferences();
  if (!TerminalRunStates.has(run.state)) return null;
  const unchecked = run.error?.code === "CHECK_BLOCKED" && !check;
  const heading = check ? (ui.locale === "en" ? { passed: "Key flows passed", failed: "Key flows failed", blocked: "Key flows blocked" } : { passed: "关键流程检查通过", failed: "关键流程检查未通过", blocked: "关键流程检查受阻" })[check.verdict] : unchecked && candidateSaved ? ui.text("候选已保存 · 尚未检查", "Candidate saved · not checked")
    : unchecked ? ui.text("检查尚未完成", "Check incomplete") : run.state === "completed" ? ui.text("版本已保存", "Version saved")
      : run.state === "needs_input" ? ui.text("还需要一点信息", "More information needed") : run.state === "cancelled" ? ui.text("任务已停止", "Run stopped") : ui.text("这次生成未完成", "Generation incomplete");
  return <div className="run-notice generation-outcome" role="status" data-testid="run-result">
    <TriangleAlert size={16} /><div><strong>{heading}</strong><p id={run.state === "needs_input" && run.clarification ? "clarification-question" : undefined}>{run.state === "needs_input" && run.clarification ? run.clarification.question : check?.summary ?? run.error?.message ?? run.summary ?? ui.text("可以查看已保存的任务记录。", "You can review the saved activity.")}</p>
      {run.state === "needs_input" && run.clarification && <p>{ui.text("本次任务已结束。填写回答后会接着原需求继续。", "Answer the question to continue the original request.")}</p>}
      {unchecked && candidateSaved && <p>{ui.text("构建与源码保存已完成，行为检查尚未完成。此候选尚未成为当前版本。", "Build and source are saved, but this candidate has not passed review.")}</p>}
      {run.state === "needs_changes" && run.attempt > 0 && <p>{ui.text(`已尝试修复 ${run.attempt} 轮${run.attempt >= 2 ? "，已达上限，停止自动修复。" : "。"}`, `${run.attempt} repair rounds attempted${run.attempt >= 2 ? "; limit reached." : "."}`)}</p>}
      <details><summary>{ui.text("任务详情", "Run details")}</summary><p className="generation-identifier">{run.id}</p>{run.error && <p>{run.error.code}</p>}</details>
    </div>
  </div>;
}
