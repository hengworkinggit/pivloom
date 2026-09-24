"use client";

import type { TaskListItem } from "@pivloom/contracts";
import { LoaderCircle } from "lucide-react";
import { taskDetailCopy, taskStateCopy, taskTone } from "@/lib/task-queue";
import { useUiPreferences } from "@/lib/ui-preferences";
import { relativeTime } from "@/lib/utils";
import { Button } from "./ui/button";

/**
 * The caller's own tasks, read from the scheduler. Queued rows show the real
 * position when the backend reported one; a row without a position stays
 * "排队中" instead of inventing an estimate.
 */
export function TaskQueuePanel({ tasks, stoppingId, onCancel }: {
  tasks: TaskListItem[];
  stoppingId: string | null;
  onCancel(task: TaskListItem): void;
}) {
  const ui = useUiPreferences();
  if (!tasks.length) return <p className="task-queue-empty" role="status">{ui.text("还没有任务。提交需求后会出现在这里。", "No tasks yet. New requests appear here.")}</p>;
  return <ul className="task-queue-list" aria-label={ui.text("我的任务", "My tasks")}>
    {tasks.map((task) => {
      const tone = taskTone(task.state);
      const state = taskStateCopy(task);
      const detail = taskDetailCopy(task);
      const stopping = stoppingId === task.runId;
      return <li key={task.runId} className={`task-queue-item tone-${tone}`} data-testid={`task-${task.state}`}>
        <div className="task-queue-main">
          <div className="task-queue-heading">
            <strong>{task.projectTitle}</strong>
            <span className={`task-chip tone-${tone}`}><span className="mini-dot" />{ui.text(state.zh, state.en)}</span>
          </div>
          <p className="task-queue-detail">{ui.text(detail.zh, detail.en)}</p>
          {task.queuedAt && task.state === "queued" && <p className="task-queue-meta">
            <time dateTime={task.queuedAt}>{ui.text(`排队于 ${relativeTime(task.queuedAt)}`, `Queued ${new Date(task.queuedAt).toLocaleTimeString()}`)}</time>
          </p>}
        </div>
        {task.cancelable && <Button type="button" variant="outline" size="sm" disabled={stopping}
          onClick={() => onCancel(task)}
          aria-label={ui.text(task.state === "queued" ? `取消排队任务：${task.projectTitle}` : `停止任务：${task.projectTitle}`,
            task.state === "queued" ? `Cancel queued task: ${task.projectTitle}` : `Stop task: ${task.projectTitle}`)}>
          {stopping ? <><LoaderCircle className="spin" size={14} />{ui.text("正在停止", "Stopping")}</> : ui.text(task.state === "queued" ? "取消排队" : "停止", task.state === "queued" ? "Cancel" : "Stop")}
        </Button>}
      </li>;
    })}
  </ul>;
}
