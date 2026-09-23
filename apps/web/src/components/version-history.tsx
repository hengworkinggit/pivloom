"use client";

import { useState } from "react";
import type { ProjectMessage, Revision, RevisionDiffResponse } from "@pivloom/contracts";
import { useUiPreferences } from "@/lib/ui-preferences";

function statusLabel(revision: Revision, currentRevisionId: string | null, english: boolean) {
  if (revision.id === currentRevisionId) return english ? "Current" : "当前";
  return english ? { accepted: "Accepted", candidate: "Candidate", rejected: "Rejected" }[revision.status]
    : { accepted: "已验收", candidate: "候选", rejected: "未通过" }[revision.status];
}

export function VersionHistoryPanel({ revisions, currentRevisionId, selectedRevision, messages, onSelect, onCompare,
  comparison, comparing, comparisonError, historyError = "" }: {
  revisions: Revision[]; currentRevisionId: string | null; selectedRevision: Revision | null;
  messages: ProjectMessage[]; onSelect: (revisionId: string) => void;
  onCompare: (fromRevisionId: string, toRevisionId: string) => void;
  comparison: RevisionDiffResponse | null; comparing: boolean; comparisonError: string; historyError?: string;
}) {
  const ui = useUiPreferences();
  const english = ui.locale === "en";
  const [chosenBaseId, setChosenBaseId] = useState("");
  const defaultBase = selectedRevision && (
    revisions.find((revision) => revision.revisionNo < selectedRevision.revisionNo)
    ?? revisions.find((revision) => revision.id !== selectedRevision.id));
  const base = revisions.find((revision) => revision.id === chosenBaseId && revision.id !== selectedRevision?.id) ?? defaultBase;
  const selectedMessages = selectedRevision ? messages.filter((message) => message.runId === selectedRevision.runId) : [];
  const current = revisions.find((revision) => revision.id === currentRevisionId);
  const visibleDiff = comparison && comparison.toRevision.id === selectedRevision?.id && comparison.fromRevision.id === base?.id ? comparison : null;

  if (!revisions.length) return null;
  return <section className="version-history" aria-label={ui.text("版本历史", "Version history")}>
    <div className="version-history-picker">
      <label htmlFor="history-version-select">{ui.text("查看版本", "View version")}</label>
      <select id="history-version-select" data-testid="history-version-select" value={selectedRevision?.id ?? ""} onChange={(event) => onSelect(event.target.value)}>
        {revisions.map((revision) => <option key={revision.id} value={revision.id}>v{revision.revisionNo} · {statusLabel(revision, currentRevisionId, english)}</option>)}
      </select>
      <span className="version-history-current">{ui.text("当前", "Current")} {current ? `v${current.revisionNo}` : "—"}</span>
    </div>
    <p className="version-history-context">{ui.text("正在查看", "Viewing")} {selectedRevision ? `v${selectedRevision.revisionNo}` : "—"}
      {selectedRevision && selectedRevision.id !== currentRevisionId && <span> · {ui.text("只读；后续生成仍以当前版本为基线", "Read only; the next run still uses the current version")}</span>}
    </p>
    {historyError && <p className="version-history-error" role="alert">{historyError}</p>}
    <details className="version-history-details">
      <summary>{ui.text(`全部 ${revisions.length} 个已保存版本`, `All ${revisions.length} saved versions`)}</summary>
      <ol>{revisions.map((revision) => <li key={revision.id}>
        <button type="button" aria-current={revision.id === selectedRevision?.id ? "true" : undefined}
          onClick={() => onSelect(revision.id)}>
          <strong>v{revision.revisionNo} · {statusLabel(revision, currentRevisionId, english)}</strong>
          <span>{new Date(revision.createdAt).toLocaleString(english ? "en-US" : "zh-CN", { hour12: false })}</span>
          <small>{revision.manifest.length} {ui.text("个文件", "files")} · {revision.sourceHash.slice(0, 12)}</small>
        </button>
      </li>)}</ol>
    </details>
    {selectedRevision && <details className="version-history-details version-history-provenance">
      <summary>{ui.text("版本来源与对话", "Version and conversation")}</summary>
      <dl><dt>{ui.text("版本 ID", "Revision ID")}</dt><dd>{selectedRevision.id}</dd>
        <dt>sourceHash</dt><dd>{selectedRevision.sourceHash}</dd>
        <dt>Run ID</dt><dd>{selectedRevision.runId}</dd>
        <dt>{ui.text("构建", "Build")}</dt><dd>{selectedRevision.buildStatus}</dd></dl>
      <ol className="version-history-messages">{selectedMessages.map((message) => <li key={message.id}><strong>{message.kind === "user" ? ui.text("需求", "Request") : message.kind === "question" ? ui.text("澄清", "Question") : ui.text("结果", "Result")}</strong><p>{message.content}</p></li>)}</ol>
      {!selectedMessages.length && <p>{ui.text("此版本没有可展示的对话记录。", "No conversation messages for this version.")}</p>}
    </details>}
    {selectedRevision && revisions.length > 1 && <details className="version-history-details version-history-compare" open={!!visibleDiff || undefined}>
      <summary>{ui.text("比较完整源码", "Compare complete source")}</summary>
      <div className="version-history-compare-controls">
        <label htmlFor="history-base-select">{ui.text("从", "From")}</label>
        <select id="history-base-select" value={base?.id ?? ""} onChange={(event) => setChosenBaseId(event.target.value)}>
          {revisions.filter((revision) => revision.id !== selectedRevision.id).map((revision) => <option key={revision.id} value={revision.id}>v{revision.revisionNo} · {statusLabel(revision, currentRevisionId, english)}</option>)}
        </select><span>→ v{selectedRevision.revisionNo}</span>
        <button type="button" disabled={!base || comparing} onClick={() => base && onCompare(base.id, selectedRevision.id)}>{comparing ? ui.text("比较中…", "Comparing…") : ui.text("查看差异", "Show diff")}</button>
      </div>
      {comparisonError && <p className="version-history-error" role="alert">{comparisonError}</p>}
      {visibleDiff && <div className="version-history-diff" data-testid="version-history-diff">
        <p>{ui.text("完整文件集合", "Complete file trees")}: v{visibleDiff.fromRevision.revisionNo} {visibleDiff.fromRevision.manifest.length} → v{visibleDiff.toRevision.revisionNo} {visibleDiff.toRevision.manifest.length}; {visibleDiff.unchangedCount} {ui.text("个未变，", "unchanged, ")}{visibleDiff.changes.length} {ui.text("处差异", "changes")}</p>
        {!visibleDiff.changes.length && <p>{ui.text("源码内容没有变化。", "No source content changed.")}</p>}
        {visibleDiff.changes.map((change, index) => <details className="version-history-change" key={`${change.kind}:${change.from?.path ?? ""}:${change.to?.path ?? ""}:${index}`}>
          <summary><span className={`version-history-kind kind-${change.kind}`}>{english ? { added: "Added", removed: "Removed", modified: "Modified", moved: "Moved" }[change.kind] : { added: "新增", removed: "删除", modified: "修改", moved: "移动" }[change.kind]}</span>
            <span>{change.kind === "moved" ? `${change.from?.path} → ${change.to?.path}` : change.to?.path ?? change.from?.path}</span></summary>
          <pre aria-label={ui.text("源码差异", "Source diff")}>{change.patch.split("\n").map((line, lineNo) => <span key={lineNo} className={line.startsWith("@@") ? "diff-hunk" : line.startsWith("+") && !line.startsWith("+++") ? "diff-add" : line.startsWith("-") && !line.startsWith("---") ? "diff-remove" : ""}>{line}{"\n"}</span>)}</pre>
        </details>)}
      </div>}
    </details>}
  </section>;
}
