"use client";

import { LoaderCircle, TriangleAlert } from "lucide-react";
import { TerminalRunStates, type Run, type RunEvent, type RunPhase } from "@pivloom/contracts";
import { LoomMark } from "./brand";

const phaseLabels: Record<RunPhase, string> = {
  plan: "正在整理需求", provision: "正在准备构建环境", implement: "正在编写应用",
  build: "正在检查与构建", snapshot: "正在保存源码快照", review: "正在处理检查结果",
  persist: "正在保存结果", cleanup: "正在清理执行资源",
};
const eventLabels: Partial<Record<RunEvent["type"], string>> = {
  "run.accepted": "需求已接收", "role.started": "开始执行", "role.completed": "执行结束",
  "tool.started": "调用工具", "tool.completed": "工具执行结束", "revision.saved": "源码快照已保存",
  "preview.ready": "预览已就绪", "check.completed": "检查结果已记录", "run.finished": "任务已结束",
};
const textValue = (value: unknown) => typeof value === "string" ? value : "";
function describe(event: RunEvent) {
  const phase = textValue(event.payload.phase);
  if (event.type === "run.phase") return phase in phaseLabels ? phaseLabels[phase as RunPhase] : "执行阶段更新";
  const detail = textValue(event.payload.toolName) || textValue(event.payload.tool) || textValue(event.payload.role);
  return [eventLabels[event.type] ?? "执行状态更新", detail].filter(Boolean).join(" · ");
}

export function GenerationActivity({ run, events }: { run: Run; events: RunEvent[] }) {
  const active = !TerminalRunStates.has(run.state);
  const visible = events.filter((event) => event.runId === run.id);
  const latest = visible.filter((event) => event.type !== "tool.output").slice(-4);
  return <article className="assistant-message active-message" data-testid="role-timeline">
    <div className="assistant-message-heading"><LoomMark /><strong>Pivloom</strong><span>{active ? "处理中" : "任务记录"}</span></div>
    <div className="assistant-message-body">
      <p className="run-label" role="status">{active && <LoaderCircle className="spin" size={13} />}{run.state === "accepted" ? "需求已接收" : active ? phaseLabels[run.phase] : "本次任务已结束"}</p>
      <p className="generation-run-model">模型配置 v{run.modelConfigVersion} · 任务 {run.id.slice(0, 8)}</p>
      {latest.length > 0 && <ul className="generation-activity-list">{latest.map((event) => <li key={event.eventId}>{describe(event)}</li>)}</ul>}
      {visible.length > 0 && <details className="generation-event-log"><summary>查看真实执行记录 <span>{visible.length}</span></summary>
        <ol>{visible.map((event) => <li key={event.eventId}><strong>{describe(event)}</strong><time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleTimeString("zh-CN", { hour12: false })}</time>
          {event.type === "tool.output" && <pre>{(textValue(event.payload.output) || textValue(event.payload.text) || textValue(event.payload.message)).slice(0, 8000) || "工具输出已记录"}</pre>}
        </li>)}</ol>
      </details>}
    </div>
  </article>;
}

export function GenerationOutcome({ run, candidateSaved }: { run: Run; candidateSaved: boolean }) {
  if (!TerminalRunStates.has(run.state)) return null;
  const unchecked = run.error?.code === "CHECK_BLOCKED";
  const heading = unchecked && candidateSaved ? "候选已保存 · 尚未检查"
    : unchecked ? "检查尚未完成" : run.state === "completed" ? "版本已保存"
      : run.state === "needs_input" ? "还需要一点信息" : run.state === "cancelled" ? "任务已停止" : "这次生成未完成";
  return <div className="run-notice generation-outcome" role="status" data-testid="run-result">
    <TriangleAlert size={16} /><div><strong>{heading}</strong><p>{run.error?.message ?? run.summary ?? "可以查看已保存的任务记录。"}</p>
      {unchecked && candidateSaved && <p>构建与源码保存已完成，行为检查尚未完成。此候选尚未成为当前版本。</p>}
      <details><summary>任务详情</summary><p className="generation-identifier">{run.id}</p>{run.error && <p>{run.error.code}</p>}</details>
    </div>
  </div>;
}
