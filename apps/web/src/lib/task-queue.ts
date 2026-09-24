import { TerminalRunStates, type RunPhase, type RunState, type TaskListItem } from "@pivloom/contracts";

/** Visual tone for one task row; the workbench renders every tone once. */
export type QueueTone = "waiting" | "running" | "attention" | "stopping" | "failed" | "done";
export interface QueueCopy { zh: string; en: string }

const phaseCopy: Record<RunPhase, QueueCopy> = {
  plan: { zh: "规划需求", en: "Planning" },
  provision: { zh: "准备执行环境", en: "Preparing environment" },
  implement: { zh: "编写代码", en: "Writing code" },
  build: { zh: "构建应用", en: "Building" },
  snapshot: { zh: "保存源码", en: "Saving source" },
  review: { zh: "检查应用", en: "Reviewing" },
  persist: { zh: "保存结果", en: "Persisting" },
  cleanup: { zh: "清理执行资源", en: "Cleaning up" },
};

export function taskTone(state: RunState): QueueTone {
  if (state === "queued") return "waiting";
  if (state === "cancel_requested") return "stopping";
  if (state === "failed" || state === "needs_changes") return "failed";
  if (state === "needs_input") return "attention";
  if (TerminalRunStates.has(state)) return "done";
  return "running";
}

/** One primary label per task. Queue position is only shown when the
 * scheduler actually reported one; a running task never invents a position. */
export function taskStateCopy(task: Pick<TaskListItem, "state" | "queuePosition">): QueueCopy {
  switch (task.state) {
    case "queued":
      return task.queuePosition
        ? { zh: `排队中 · 第 ${task.queuePosition} 位`, en: `Queued · position ${task.queuePosition}` }
        : { zh: "排队中", en: "Queued" };
    case "accepted":
    case "planning":
    case "building":
    case "verifying":
    case "repairing":
    case "finalizing":
      return { zh: "执行中", en: "Running" };
    case "cancel_requested":
      return { zh: "正在停止", en: "Stopping" };
    case "completed":
      return { zh: "已完成", en: "Completed" };
    case "needs_input":
      return { zh: "等待你补充信息", en: "Waiting for your answer" };
    case "needs_changes":
      return { zh: "需要修改", en: "Changes requested" };
    case "failed":
      return { zh: "已失败", en: "Failed" };
    case "cancelled":
      return { zh: "已取消", en: "Cancelled" };
    case "interrupted":
      return { zh: "已中断", en: "Interrupted" };
  }
}

/** Secondary line: what the task is doing right now, or why it stopped. */
export function taskDetailCopy(task: Pick<TaskListItem, "state" | "phase" | "error">): QueueCopy {
  if (task.error) return { zh: task.error.message, en: task.error.message };
  if (task.state === "queued") return { zh: "资源可用后会自动开始，不需要重新提交。", en: "Starts automatically when capacity frees up." };
  return phaseCopy[task.phase];
}

export function taskIsOpen(state: RunState) {
  return !TerminalRunStates.has(state);
}

/** Owner task summary used by the header badge and the project list banner. */
export function summarizeTasks(tasks: TaskListItem[]) {
  const open = tasks.filter((task) => taskIsOpen(task.state));
  const queued = open.filter((task) => task.state === "queued");
  const failed = tasks.filter((task) => task.state === "failed" || task.state === "needs_changes");
  const attention = tasks.filter((task) => task.state === "needs_input");
  return {
    open: open.length, queued: queued.length, failed: failed.length, attention: attention.length,
    position: queued.reduce<number | null>((best, task) => task.queuePosition && (best === null || task.queuePosition < best) ? task.queuePosition : best, null),
    cancelable: open.filter((task) => task.cancelable),
  };
}
