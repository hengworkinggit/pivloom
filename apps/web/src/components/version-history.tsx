"use client";

import { useState } from "react";
import type { ProjectMessage, Revision, RevisionDiffResponse, RollbackOperation } from "@pivloom/contracts";
import { useUiPreferences } from "@/lib/ui-preferences";
import { displayRevision, snapshotLabel } from "@/lib/revision-label";

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
  return english ? { accepted: "Accepted", candidate: "Incomplete", rejected: "Did not pass" }[revision.status]
    : { accepted: "已验收", candidate: "未完成", rejected: "未通过" }[revision.status];
}

export function VersionHistoryPanel({ revisions, currentRevisionId, selectedRevision, messages, onSelect, onCompare,
  comparison, comparing, comparisonError, historyError = "", currentFromRollback = false,
  continueFromRevisionId = null, onContinueFrom, continueDisabled = false, completeHistory = true, rollback }: {
  revisions: Revision[]; currentRevisionId: string | null; selectedRevision: Revision | null;
  messages: ProjectMessage[]; onSelect: (revisionId: string) => void;
  onCompare: (fromRevisionId: string, toRevisionId: string) => void;
  comparison: RevisionDiffResponse | null; comparing: boolean; comparisonError: string; historyError?: string;
  currentFromRollback?: boolean;
  completeHistory?: boolean;
  continueFromRevisionId?: string | null;
  onContinueFrom?: (revision: Revision | null) => void; continueDisabled?: boolean;
  rollback?: RollbackActions;
}) {
  const ui = useUiPreferences();
  const english = ui.locale === "en";
  const label = (revision: Revision) => displayRevision(revision, completeHistory ? revisions : null, english);
  const [chosenBaseId, setChosenBaseId] = useState("");
  const [showAttempts, setShowAttempts] = useState(() => !currentRevisionId || selectedRevision?.status !== "accepted");
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
  const acceptedHistory = revisions.filter((revision) => revision.status === "accepted" && revision.id !== currentRevisionId);
  const unfinished = revisions.filter((revision) => revision.status !== "accepted");
  const showUnfinishedInPicker = showAttempts || selectedRevision?.status !== "accepted";
  const rollbackTarget = confirmation && revisions.find((revision) => revision.id === confirmation.targetId);
  const rollbackFrom = confirmation && revisions.find((revision) => revision.id === confirmation.fromId);
  const operationTarget = rollback?.operation && revisions.find((revision) => revision.id === rollback.operation?.targetRevisionId);
  const visibleDiff = comparison && comparison.toRevision.id === selectedRevision?.id && comparison.fromRevision.id === base?.id ? comparison : null;
  const selectedKind = selectedRevision?.id === currentRevisionId
    ? ui.text("当前成功版本", "Current accepted version")
    : selectedRevision?.status === "accepted" ? ui.text("历史已验收版本", "Previously accepted version")
      : selectedRevision?.status === "candidate" ? ui.text("未完成的尝试 · 尚非正式版本", "Incomplete attempt · not the current version")
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
        <strong>{current ? label(current) : ui.text("暂无", "None yet")}</strong></div>
      {current ? <>
        <div className="version-history-hash-row"><span>{ui.text("作品源码 hash", "App source hash")}</span>
          <code data-testid="current-source-hash-short" title={current.sourceHash}>{current.sourceHash.slice(0, 12)}…</code>
          <button type="button" onClick={() => void copyCurrentHash()} aria-label={ui.text("复制完整源码 hash", "Copy full source hash")}>{copiedHash === current.sourceHash ? ui.text("已复制", "Copied") : ui.text("复制完整 hash", "Copy full hash")}</button></div>
        <details className="version-history-full-hash"><summary>{ui.text("查看完整源码 hash", "View full source hash")}</summary><code>{current.sourceHash}</code></details>
        {copyFailedHash === current.sourceHash && <p className="version-history-copy-error" role="status">{ui.text("无法自动复制，可展开并手动选择完整 hash。", "Copy unavailable. Expand and select the full hash manually.")}</p>}
      </> : <p>{ui.text("尚无通过检查的正式版本。", "No version has passed checks yet.")}</p>}
      <p className="version-history-count-explanation">{completeHistory
        ? ui.text(`这里有 ${acceptedHistory.length + (current ? 1 : 0)} 个正式版、${unfinished.length} 次未完成尝试，共 ${revisions.length} 份源码快照。正式版按验收通过顺序编号，尝试保留源码快照编号。`,
          `${acceptedHistory.length + (current ? 1 : 0)} accepted versions and ${unfinished.length} incomplete attempts across ${revisions.length} source snapshots. Accepted versions and attempts have separate numbering.`)
        : ui.text("完整版本历史正在读取；当前只显示已加载的源码快照。", "Loading full version history; only available snapshots are shown.")}</p>
      <p className="version-history-hash-note">{ui.text("这是作品源码版本标识，不是平台部署 SHA。", "This identifies the app source, not the platform deployment SHA.")}</p>
    </div>
    <div className="version-history-picker">
      <label htmlFor="history-version-select">{ui.text("查看版本", "View version")}</label>
      <select id="history-version-select" data-testid="history-version-select" value={selectedRevision?.id ?? ""} onChange={(event) => { setConfirmation(null); onSelect(event.target.value); }}>
        {current && <option value={current.id}>{label(current)} · {ui.text("当前", "Current")}</option>}
        {acceptedHistory.length > 0 && <optgroup label={ui.text("通过检查的历史版本", "Previously accepted versions")}>{acceptedHistory.map((revision) =>
          <option key={revision.id} value={revision.id}>{label(revision)} · {statusLabel(revision, currentRevisionId, english)}</option>)}</optgroup>}
        {showUnfinishedInPicker && unfinished.length > 0 && <optgroup label={ui.text(`未完成尝试（${unfinished.length}）`, `Incomplete attempts (${unfinished.length})`)}>{unfinished.map((revision) =>
          <option key={revision.id} value={revision.id}>{label(revision)} · {statusLabel(revision, currentRevisionId, english)}</option>)}</optgroup>}
      </select>
      {current && unfinished.length > 0 && <button type="button" className="version-history-attempts-toggle" aria-expanded={showUnfinishedInPicker}
        onClick={() => { const next = !showUnfinishedInPicker; setShowAttempts(next); if (!next && selectedRevision?.status !== "accepted") onSelect(current.id); }}>
        {showUnfinishedInPicker ? ui.text("收起未完成尝试", "Hide incomplete attempts") : ui.text(`查看 ${unfinished.length} 次未完成尝试`, `View ${unfinished.length} incomplete attempts`)}
      </button>}
    </div>
    {onContinueFrom && selectedRevision && selectedRevision.status !== "accepted" && selectedRevision.buildStatus === "passed" &&
      <div className="version-history-continue"><p>{selectedRevision.id === continueFromRevisionId
        ? ui.text(`下次修改已选择从 ${label(selectedRevision)} 开始；当前正式版与发布内容不变。`, `The next change starts from ${label(selectedRevision)}; current and published versions stay unchanged.`)
        : ui.text("这次尝试没有成为正式版本。若其中有想保留的修改，可以从它继续开发；仅查看版本不会改变下一次修改的起点。", "This attempt did not become current. Continue from it only if you want to keep its changes; viewing alone changes nothing.")}</p>
        <button type="button" disabled={continueDisabled} onClick={() => onContinueFrom(selectedRevision.id === continueFromRevisionId ? null : selectedRevision)}>
          {selectedRevision.id === continueFromRevisionId ? ui.text("改回从正式版继续", "Use current version instead")
            : ui.text(`从 ${label(selectedRevision)} 继续修改`, `Continue editing from ${label(selectedRevision)}`)}
        </button></div>}
    <div className="version-history-context" data-testid="selected-version-kind"><strong>{ui.text("正在查看", "Viewing")} {selectedRevision ? label(selectedRevision) : "—"}</strong>
      {selectedRevision && <span className="version-history-context-badge">{selectedKind}</span>}
      {selectedRevision && selectedRevision.id !== currentRevisionId && <p>{selectedRevision.id === continueFromRevisionId
        ? ui.text("下次修改将从此版本开始；当前正式版本与发布内容不变。", "The next change starts here; the current and published versions stay unchanged.")
        : ui.text("当前仅供查看；下次修改默认从正式版本开始。", "Viewing only; the next change starts from the current version by default.")}</p>}
      {selectedRevision?.id === currentRevisionId && currentFromRollback && <p>{ui.text("当前正式版本由历史版本恢复", "Current version restored from history")}</p>}
    </div>
    {rollback && selectedRevision?.status === "accepted" && selectedRevision.buildStatus === "passed"
      && currentRevisionId && selectedRevision.id !== currentRevisionId && !rollback.busy && !confirmation &&
      <div className="version-history-rollback-entry"><p>{ui.text("这个历史版本已通过验收，可以恢复为当前版本。", "This previously accepted version can become the current version.")}</p>
        <button type="button" className="version-history-rollback-trigger" disabled={rollback.disabled}
          onClick={() => setConfirmation({ fromId: currentRevisionId, targetId: selectedRevision.id })}>
          {ui.text(`回滚到 ${label(selectedRevision)}`, `Rollback to ${label(selectedRevision)}`)}
        </button></div>}
    {rollback && confirmation && rollbackTarget && rollbackFrom && <div className="version-history-rollback-confirm" role="group" aria-label={ui.text("确认回滚版本", "Confirm version rollback")}>
      <strong>{ui.text("确认切换当前版本", "Confirm current version change")}</strong>
      <p data-testid="rollback-direction">{label(rollbackFrom)} → {label(rollbackTarget)}</p>
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
        {ui.text("目标版本", "Target version")} {operationTarget ? label(operationTarget) : "—"}</p>}
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
      <summary>{ui.text(`展开全部源码快照 · ${revisions.length} 份`, `Open all source snapshots · ${revisions.length}`)}</summary>
      <ol>{revisions.map((revision) => <li key={revision.id}>
        <button type="button" aria-current={revision.id === selectedRevision?.id ? "true" : undefined}
          onClick={() => { setConfirmation(null); onSelect(revision.id); }}>
          <strong>{label(revision)} · {snapshotLabel(revision, english)} · {statusLabel(revision, currentRevisionId, english)}</strong>
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
      <p>{snapshotLabel(selectedRevision, english)} · {ui.text("历史对话可能使用源码快照编号。", "Older conversation entries may use source-snapshot numbers.")}</p>
      <ol className="version-history-messages">{selectedMessages.map((message) => <li key={message.id}><strong>{message.kind === "rollback" ? ui.text("回滚事件", "Rollback event") : message.kind === "user" ? ui.text("需求", "Request") : message.kind === "question" ? ui.text("澄清", "Question") : ui.text("结果", "Result")}</strong><p>{message.content}</p></li>)}</ol>
      {!selectedMessages.length && <p>{ui.text("此版本没有可展示的对话记录。", "No conversation messages for this version.")}</p>}
    </details>}
    {selectedRevision && revisions.length > 1 && <details className="version-history-details version-history-compare" open={!!visibleDiff || undefined}>
      <summary>{ui.text("比较完整源码", "Compare complete source")}</summary>
      <div className="version-history-compare-controls">
        <label htmlFor="history-base-select">{ui.text("从", "From")}</label>
        <select id="history-base-select" value={base?.id ?? ""} onChange={(event) => setChosenBaseId(event.target.value)}>
          {revisions.filter((revision) => revision.id !== selectedRevision.id).map((revision) => <option key={revision.id} value={revision.id}>{label(revision)} · {statusLabel(revision, currentRevisionId, english)}</option>)}
        </select><span>→ {label(selectedRevision)}</span>
        <button type="button" disabled={!base || comparing} onClick={() => base && onCompare(base.id, selectedRevision.id)}>{comparing ? ui.text("比较中…", "Comparing…") : ui.text("查看差异", "Show diff")}</button>
      </div>
      {comparisonError && <p className="version-history-error" role="alert">{comparisonError}</p>}
      {visibleDiff && <div className="version-history-diff" data-testid="version-history-diff">
        <p>{ui.text("完整文件集合", "Complete file trees")}: {label(visibleDiff.fromRevision)} {visibleDiff.fromRevision.manifest.length} → {label(visibleDiff.toRevision)} {visibleDiff.toRevision.manifest.length}; {visibleDiff.unchangedCount} {ui.text("个未变，", "unchanged, ")}{visibleDiff.changes.length} {ui.text("处差异", "changes")}</p>
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
