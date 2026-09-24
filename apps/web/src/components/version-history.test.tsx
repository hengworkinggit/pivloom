import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import type { ProjectMessage, Revision, RevisionDiffResponse } from "@pivloom/contracts";
import { VersionHistoryPanel, type RollbackActions } from "./version-history";

afterEach(() => { document.body.replaceChildren(); });

test("history identifies current versus inspected versions and exposes full-tree changes without switching current", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const projectId = "13cb9167-7a4c-4f85-866b-c5f2e2beb65f";
  const now = "2026-09-24T00:00:00.000Z";
  const rev = (id: string, no: number, status: Revision["status"]): Revision => ({
    id, projectId, runId: `00000000-0000-4000-8000-00000000000${no}`, revisionNo: no, attempt: 0,
    sourceHash: String(no).repeat(64), templateVersion: "fixture", buildStatus: "passed", status, createdAt: now,
    manifest: [{ path: "src/App.tsx", bytes: 3, sha256: "a".repeat(64) }],
  });
  const current = rev("00000000-0000-4000-8000-000000000003", 3, "accepted");
  const selected = rev("00000000-0000-4000-8000-000000000002", 2, "accepted");
  const rejected = rev("00000000-0000-4000-8000-000000000001", 1, "rejected");
  const messages: ProjectMessage[] = [{ id: "00000000-0000-4000-8000-000000000004", projectId,
    runId: selected.runId, kind: "user", content: "把按钮改成蓝色", createdAt: now }];
  const comparison: RevisionDiffResponse = { projectId, fromRevision: rejected, toRevision: selected, unchangedCount: 1,
    changes: [{ kind: "moved", from: { path: "src/旧/颜色.css", bytes: 3, sha256: "b".repeat(64) },
      to: { path: "src/新/颜色.css", bytes: 3, sha256: "b".repeat(64) }, patch: "--- src/旧/颜色.css\n+++ src/新/颜色.css\n" }] };
  const onSelect = vi.fn();
  const onCompare = vi.fn();
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<VersionHistoryPanel revisions={[current, selected, rejected]} currentRevisionId={current.id}
    selectedRevision={selected} messages={messages} onSelect={onSelect} onCompare={onCompare}
    comparison={comparison} comparing={false} comparisonError="" />));
  expect(container.querySelector('[data-testid="current-version-summary"]')?.textContent).toContain("当前成功版本v3");
  expect(container.querySelector('[data-testid="current-source-hash-short"]')?.textContent).toContain("333333333333");
  expect(container.querySelector(".version-history-full-hash")?.textContent).toContain(current.sourceHash);
  expect(container.textContent).toContain("不是平台部署 SHA");
  expect(container.textContent).toContain("正在查看 v2");
  expect(container.querySelector('[data-testid="selected-version-kind"]')?.textContent).toContain("历史已验收版本");
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="复制完整源码 hash"]')?.click());
  expect(writeText).toHaveBeenCalledWith(current.sourceHash);
  expect(container.textContent).toContain("已复制");
  expect(container.textContent).toContain("把按钮改成蓝色");
  expect(container.textContent).toContain("src/旧/颜色.css");
  expect(container.textContent).toContain("src/新/颜色.css");
  expect(container.textContent).toContain("v1 · 未通过");
  const compare = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "查看差异")!;
  await act(async () => compare.click());
  expect(onCompare).toHaveBeenCalledWith(rejected.id, selected.id);
  const pick = container.querySelector<HTMLSelectElement>("select[data-testid='history-version-select']")!;
  await act(async () => { pick.value = rejected.id; pick.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(onSelect).toHaveBeenCalledWith(rejected.id);
  expect(current.id).toBe("00000000-0000-4000-8000-000000000003");
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

test("accepted history requires an explicit from-to confirmation and exposes the persisted rollback result", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const projectId = "13cb9167-7a4c-4f85-866b-c5f2e2beb65f";
  const now = "2026-09-24T00:00:00.000Z";
  const revision = (id: string, no: number, status: Revision["status"]): Revision => ({
    id, projectId, runId: `00000000-0000-4000-8000-00000000000${no}`, revisionNo: no, attempt: 0,
    sourceHash: String(no).repeat(64), templateVersion: "fixture", buildStatus: "passed", status, createdAt: now,
    manifest: [{ path: "src/App.tsx", bytes: 3, sha256: "a".repeat(64) }],
  });
  const current = revision("00000000-0000-4000-8000-000000000003", 3, "accepted");
  const target = revision("00000000-0000-4000-8000-000000000001", 1, "accepted");
  const rejected = revision("00000000-0000-4000-8000-000000000002", 2, "rejected");
  const start = vi.fn(), clearResult = vi.fn();
  const rollback: RollbackActions = { busy: false, unknown: false, disabled: false, operation: null, error: "", storageWarning: false,
    start, confirm: vi.fn(), cancel: vi.fn(), clearResult };
  const messages: ProjectMessage[] = [{ id: "00000000-0000-4000-8000-000000000004", projectId,
    runId: null, rollbackId: "00000000-0000-4000-8000-000000000005", kind: "rollback",
    content: "已从 v3 回滚到 v1。后续修改将以 v1 为基线。", createdAt: now }];
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const render = (selected: Revision, currentRevisionId = current.id, currentFromRollback = false) => root.render(
    <VersionHistoryPanel revisions={[current, rejected, target]} currentRevisionId={currentRevisionId}
      selectedRevision={selected} messages={messages} onSelect={vi.fn()} onCompare={vi.fn()}
      comparison={null} comparing={false} comparisonError="" currentFromRollback={currentFromRollback} rollback={rollback} />);
  await act(async () => render(target));
  const entry = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "回滚到 v1");
  expect(entry).toBeTruthy();
  await act(async () => entry?.click());
  expect(container.querySelector('[data-testid="rollback-direction"]')?.textContent).toBe("v3 → v1");
  expect(start).not.toHaveBeenCalled();
  await act(async () => Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "确认回滚")?.click());
  expect(start).toHaveBeenCalledOnce();
  expect(start).toHaveBeenCalledWith(target.id, current.id);
  await act(async () => render(rejected));
  expect(container.textContent).not.toContain("回滚到 v2");
  rollback.operation = { id: "00000000-0000-4000-8000-000000000005", projectId,
    fromRevisionId: current.id, targetRevisionId: target.id, sourceHash: target.sourceHash,
    status: "committed", error: null, createdAt: now, finishedAt: now };
  await act(async () => render(target, target.id, true));
  expect(container.textContent).toContain("从历史版本恢复的当前基线");
  expect(container.textContent).toContain("回滚事件");
  expect(container.textContent).toContain("已从 v3 回滚到 v1");
  expect(container.textContent).toContain("回滚完成");
  await act(async () => Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "关闭提示")?.click());
  expect(clearResult).toHaveBeenCalledOnce();
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});
