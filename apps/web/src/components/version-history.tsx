"use client";

import { useState } from "react";
import type { ProjectMessage, Revision, RevisionDiffResponse, RollbackOperation } from "@pivloom/contracts";
import { useUiPreferences } from "@/lib/ui-preferences";

export interface RollbackActions {
  busy: boolean; unknown: boolean; disabled: boolean; operation: RollbackOperation | null;
  error: string; storageWarning: boolean;
  start: (targetRevisionId: string, expectedCurrentRevisionId: string) => void;
  confirm: () => void; cancel: () => void; clearResult: () => void;
}

const rollbackPhases: Record<RollbackOperation["status"], [string, string]> = {
  queued: ["沙箱容量已满，已排队等待；资源可用后会自动开始。", "Queued for sandbox capacity; it starts by itself once capacity is free."],
  preparing: ["正在准备源码与独立预览…", "Preparing source and isolated preview…"],
  prepared: ["预览已准备，正在切换当前版本…", "Preview prepared; switching current version…"],
  cancel_requested: ["正在取消，等待资源清理…", "Cancelling and cleaning up…"],
  cleanup_pending: ["正在清理执行资源…", "Cleaning up execution resources…"],
  committed: ["回滚完成，当前版本与预览已切换。", "Rollback complete; current version and preview switched."],
  failed: ["回滚失败；原当前版本保持不变。", "Rollback failed; the previous current version remains."],
  cancelled: ["回滚已取消；原当前版本保持不变。", "Rollback cancelled; the previous current version remains."],
};

function statusLabel(revision: Revision, currentRevisionId: string | null, english: boolean) {
  if (revision.id === currentRevisionId) return english ? "Current" : "当前";
  return english ? { accepted: "Accepted", candidate: "Candidate", rejected: "Rejected" }[revision.status]
    : { accepted: "已验收", candidate: "候选", rejected: "未通过" }[revision.status];
}

export function VersionHistoryPanel({ revisions, currentRevisionId, selectedRevision, messages, onSelect, onCompare,
  comparison, comparing, comparisonError, historyError = "", currentFromRollback = false, rollback }: {
  revisions: Revision[]; currentRevisionId: string | null; selectedRevision: Revision | null;
  messages: ProjectMessage[]; onSelect: (revisionId: string) => void;
  onCompare: (fromRevisionId: string, toRevisionId: string) => void;
  comparison: RevisionDiffResponse | null; comparing: boolean; comparisonError: string; historyError?: string;
  currentFromRollback?: boolean;
  rollback?: RollbackActions;
}) {
  const ui = useUiPreferences();
  const english = ui.locale === "en";
  const [chosenBaseId, setChosenBaseId] = useState("");
  const [copiedHash, setCopiedHash] = useState<string | null>(null);
  const [copyFailedHash, setCopyFailedHash] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<{ fromId: string; targetId: string } | null>(null);
  const defaultBase = selectedRevision && (
    revisions.find((revision) => revision.revisionNo < selectedRevision.revisionNo)
    ?? revisions.find((revision) => revision.id !== selectedRevision.id));
  const base = revisions.find((revision) => revision.id === chosenBaseId && revision.id !== selectedRevision?.id) ?? defaultBase;
  const currentRollbackMessage = currentFromRollback && selectedRevision?.id === currentRevisionId
    ? [...messages].reverse().find((message) => message.kind === "rollback") : null;
  const selectedMessages = selectedRevision ? [
    ...messages.filter((message) => message.runId === selectedRevision.runId),
    ...(currentRollbackMessage ? [currentRollbackMessage] : []),
  ] : [];
  const current = revisions.find((revision) => revision.id === currentRevisionId);
  const rollbackTarget = confirmation && revisions.find((revision) => revision.id === confirmation.targetId);
  const rollbackFrom = confirmation && revisions.find((revision) => revision.id === confirmation.fromId);
  const visibleDiff = comparison && comparison.toRevision.id === selectedRevision?.id && comparison.fromRevision.id === base?.id ? comparison : null;
  const selectedKind = selectedRevision?.id === currentRevisionId
    ? ui.text("当前成功版本", "Current accepted version")
    : selectedRevision?.status === "accepted" ? ui.text("历史已验收版本", "Previously accepted version")
      : selectedRevision?.status === "candidate" ? ui.text("候选版本 · 尚未验收", "Candidate · not accepted yet")
        : ui.text("未通过验收的版本", "Revision that did not pass review");

  async function copyCurrentHash() {
    if (!current) return;
    try {
      await navigator.clipboard.writeText(current.sourceHash);
      setCopiedHash(current.sourceHash);
      setCopyFailedHash(null);
    } catch {
      setCopiedHash(null);
      setCopyFailedHash(current.sourceHash);
    }
  }

  if (!revisions.length) return null;
  return <section className="version-history" aria-label={ui.text("版本历史", "Version history")}>
    <div className="version-history-hero" data-testid="current-version-summary">
      <div className="version-history-hero-heading"><span>{ui.text("当前成功版本", "Current accepted version")}</span>
        <strong>{current ? `v${current.revisionNo}` : ui.text("暂无", "None yet")}</strong></div>
      {current ? <>
        <div className="version-history-hash-row"><span>{ui.text("作品源码 hash", "App source hash")}</span>
          <code data-testid="current-source-hash-short" title={current.sourceHash}>{current.sourceHash.slice(0, 12)}…</code>
          <button type="button" onClick={() => void copyCurrentHash()} aria-label={ui.text("复制完整源码 hash", "Copy full source hash")}>{copiedHash === current.sourceHash ? ui.text("已复制", "Copied") : ui.text("复制完整 hash", "Copy full hash")}</button></div>
        <details className="version-history-full-hash"><summary>{ui.text("查看完整源码 hash", "View full source hash")}</summary><code>{current.sourceHash}</code></details>
        {copyFailedHash === current.sourceHash && <p className="version-history-copy-error" role="status">{ui.text("无法自动复制，可展开并手动选择完整 hash。", "Copy unavailable. Expand and select the full hash manually.")}</p>}
      </> : <p>{ui.text("候选版本尚未成为下一轮生成的基线。", "A candidate has not become the baseline for the next run.")}</p>}
      <p className="version-history-hash-note">{ui.text("这是作品源码版本标识，不是平台部署 SHA。", "This identifies the app source, not the platform deployment SHA.")}</p>
    </div>
    <div className="version-history-picker">
      <label htmlFor="history-version-select">{ui.text("版本历史", "Version history")}</label>
      <select id="history-version-select" data-testid="history-version-select" value={selectedRevision?.id ?? ""} onChange={(event) => { setConfirmation(null); onSelect(event.target.value); }}>
        {revisions.map((revision) => <option key={revision.id} value={revision.id}>v{revision.revisionNo} · {statusLabel(revision, currentRevisionId, english)}</option>)}
      </select>
    </div>
    <div className="version-history-context" data-testid="selected-version-kind"><strong>{ui.text("正在查看", "Viewing")} {selectedRevision ? `v${selectedRevision.revisionNo}` : "—"}</strong>
      {selectedRevision && <span className="version-history-context-badge">{selectedKind}</span>}
      {selectedRevision && selectedRevision.id !== currentRevisionId && <p>{ui.text("当前只读；下一轮生成仍以当前成功版本为基线。", "Read only; the next run still uses the current accepted version as its baseline.")}</p>}
      {selectedRevision?.id === currentRevisionId && currentFromRollback && <p>{ui.text("从历史版本恢复的当前基线", "Current baseline restored from history")}</p>}
    </div>
    {rollback && selectedRevision?.status === "accepted" && selectedRevision.buildStatus === "passed"
      && currentRevisionId && selectedRevision.id !== currentRevisionId && !rollback.busy && !confirmation &&
      <div className="version-history-rollback-entry"><p>{ui.text("这个历史版本已通过验收，可以恢复为当前版本。", "This previously accepted version can become the current version.")}</p>
        <button type="button" className="version-history-rollback-trigger" disabled={rollback.disabled}
          onClick={() => setConfirmation({ fromId: currentRevisionId, targetId: selectedRevision.id })}>
          {ui.text(`回滚到 v${selectedRevision.revisionNo}`, `Rollback to v${selectedRevision.revisionNo}`)}
        </button></div>}
    {rollback && confirmation && rollbackTarget && rollbackFrom && <div className="version-history-rollback-confirm" role="group" aria-label={ui.text("确认回滚版本", "Confirm version rollback")}>
      <strong>{ui.text("确认切换当前版本", "Confirm current version change")}</strong>
      <p data-testid="rollback-direction">v{rollbackFrom.revisionNo} → v{rollbackTarget.revisionNo}</p>
      <p>{ui.text("将从目标版本的完整源码重建预览。历史版本与对话保留；不会调用模型，也不会自动更新已发布作品。旧检查只代表目标版本当时的验收，重建后需重新验证。",
        "The preview will be rebuilt from the complete target source. History and conversation remain. This does not call a model or update the published app. Earlier checks are historical; verify the rebuilt preview again.")}</p>
      {confirmation.fromId !== currentRevisionId && <p role="alert">{ui.text("当前版本已变化，请重新选择回滚目标。", "The current version changed. Choose the rollback target again.")}</p>}
      <div className="version-history-rollback-actions">
        <button type="button" disabled={rollback.disabled || rollback.busy || confirmation.fromId !== currentRevisionId}
          onClick={() => { rollback.start(confirmation.targetId, confirmation.fromId); setConfirmation(null); }}>{ui.text("确认回滚", "Confirm rollback")}</button>
        <button type="button" onClick={() => setConfirmation(null)}>{ui.text("暂不回滚", "Keep current version")}</button>
      </div>
    </div>}
    {rollback && (rollback.busy || rollback.operation || rollback.error) && <div className="version-history-rollback-status" role="status" data-testid="rollback-status">
      {rollback.busy && !rollback.operation && !rollback.unknown && <p>{ui.text("正在读取已保存的回滚操作…", "Looking up the saved rollback operation…")}</p>}
      {rollback.operation && <p><strong>{ui.text(...rollbackPhases[rollback.operation.status])}</strong>{" · "}
        {ui.text("目标版本", "Target version")} v{revisions.find((item) => item.id === rollback.operation?.targetRevisionId)?.revisionNo ?? "—"}</p>}
      {rollback.unknown && <p>{ui.text("提交结果尚未确认；再次确认会沿用原幂等键，不会创建第二个回滚。", "Submission outcome is unknown. Confirming uses the same idempotency key and cannot create another rollback.")}</p>}
      {rollback.storageWarning && <p role="alert">{ui.text("浏览器未能保存恢复信息，请保持页面打开直到结果确认。", "The browser could not save recovery state. Keep this page open until the result is confirmed.")}</p>}
      {rollback.operation?.error && <p role="alert">{rollback.operation.error.code}: {rollback.operation.error.message}</p>}
      {rollback.error && <p role="alert">{rollback.error}</p>}
      <div className="version-history-rollback-actions">
        {rollback.unknown && <button type="button" onClick={rollback.confirm}>{ui.text("确认提交结果", "Confirm submission result")}</button>}
        {rollback.busy && !rollback.unknown && rollback.error && <button type="button" onClick={rollback.confirm}>{ui.text("重新读取操作", "Retry operation lookup")}</button>}
        {rollback.operation && ["queued", "preparing", "prepared"].includes(rollback.operation.status) && <button type="button" onClick={rollback.cancel}>{ui.text("取消回滚", "Cancel rollback")}</button>}
        {!rollback.busy && rollback.operation && ["committed", "failed", "cancelled"].includes(rollback.operation.status)
          && <button type="button" onClick={rollback.clearResult}>{ui.text("关闭提示", "Dismiss")}</button>}
      </div>
    </div>}
    {historyError && <p className="version-history-error" role="alert">{historyError}</p>}
    <details className="version-history-details">
      <summary>{ui.text(`展开版本历史 · ${revisions.length} 个已保存版本`, `Open version history · ${revisions.length} saved versions`)}</summary>
      <ol>{revisions.map((revision) => <li key={revision.id}>
        <button type="button" aria-current={revision.id === selectedRevision?.id ? "true" : undefined}
          onClick={() => { setConfirmation(null); onSelect(revision.id); }}>
          <strong>v{revision.revisionNo} · {statusLabel(revision, currentRevisionId, english)}</strong>
          <span>{new Date(revision.createdAt).toLocaleString(english ? "en-US" : "zh-CN", { hour12: false })}</span>
          <small>{revision.manifest.length} {ui.text("个文件", "files")} · {revision.sourceHash.slice(0, 12)}</small>
        </button>
      </li>)}</ol>
    </details>
    {selectedRevision && <details className="version-history-details version-history-provenance">
      <summary>{ui.text("版本来源与对话", "Version and conversation")}</summary>
      <dl><dt>{ui.text("版本 ID", "Revision ID")}</dt><dd>{selectedRevision.id}</dd>
        <dt>{ui.text("作品源码 hash", "App source hash")}</dt><dd>{selectedRevision.sourceHash}</dd>
        <dt>Run ID</dt><dd>{selectedRevision.runId}</dd>
        <dt>{ui.text("构建", "Build")}</dt><dd>{selectedRevision.buildStatus}</dd></dl>
      <ol className="version-history-messages">{selectedMessages.map((message) => <li key={message.id}><strong>{message.kind === "rollback" ? ui.text("回滚事件", "Rollback event") : message.kind === "user" ? ui.text("需求", "Request") : message.kind === "question" ? ui.text("澄清", "Question") : ui.text("结果", "Result")}</strong><p>{message.content}</p></li>)}</ol>
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
