import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import type { ProjectMessage, Revision, RevisionDiffResponse } from "@pivloom/contracts";
import { VersionHistoryPanel } from "./version-history";

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
  expect(container.textContent).toContain("当前 v3");
  expect(container.textContent).toContain("正在查看 v2");
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
