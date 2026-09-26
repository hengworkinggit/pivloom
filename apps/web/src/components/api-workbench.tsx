"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { ArrowUp, Check, ChevronDown, Copy, ExternalLink, History, ListChecks, LoaderCircle, MessageSquare, Monitor, PanelLeftClose, PanelLeftOpen, RotateCcw, TriangleAlert, X } from "lucide-react";
import { getApiWorkspace } from "@/lib/workspace";
import { WorkspaceError } from "@/lib/api-workspace";
import { usePrivateQuery, useWorkspaceAuth } from "@/lib/use-workspace";
import { promptLimit, readDraft, saveDraft, readSessionModel, saveSessionModel } from "@/lib/drafts";
import { readCandidateBase, saveCandidateBase, type CandidateBaseSelection } from "@/lib/candidate-base";
import { createModelsApi } from "@/lib/models-api";
import { clearPendingSubmission, readPendingSubmission, savePendingSubmission, type RunSubmission } from "@/lib/generation-api";
import { cn, errorMessage } from "@/lib/utils";
import { AppHeader } from "./app-header";
import { AuthGate } from "./auth-gate";
import { LoomMark } from "./brand";
import { Button } from "./ui/button";
import { useGenerationState } from "./generation-state";
import { GenerationActivity, GenerationOutcome } from "./generation-activity";
import { GenerationResult } from "./generation-result";
import { TaskQueuePanel } from "./task-queue-panel";
import { SessionModelPicker } from "./session-model-picker";
import { useUiPreferences } from "@/lib/ui-preferences";
import { useCancellationRequestLatch } from "@/lib/use-cancellation-request-latch";
import { DeploymentVersion } from "./deployment-version";
import { checkMatchesRevision, GenerationReview } from "./generation-review";
import { createVersionHistoryApi } from "@/lib/version-history-api";
import { useRollback } from "@/lib/use-rollback";
import { VersionHistoryPanel } from "./version-history";
import { summarizeTasks } from "@/lib/task-queue";
import type { Revision, TaskListItem } from "@pivloom/contracts";

const rejectedSubmissions = new Set(["INVALID_INPUT", "PROJECT_BUSY", "CLEANUP_PENDING", "STALE_BASE", "IDEMPOTENCY_CONFLICT", "SERVICE_BUSY", "QUOTA_EXCEEDED", "NOT_FOUND", "UNAUTHENTICATED", "MODEL_PROFILE_NOT_FOUND", "MODEL_CONFIG_CHANGED", "MODEL_NOT_VERIFIED", "MODEL_VISION_NOT_VERIFIED", "MODEL_CONFIGURATION_MISSING"]);

function WorkbenchDrawer({ title, onClose, children }: { title: string; onClose(): void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && typeof dialog.showModal === "function") dialog.showModal();
    else dialog?.setAttribute("open", "");
    return () => { if (dialog?.open && typeof dialog.close === "function") dialog.close(); };
  }, []);
  return <dialog ref={ref} className="a-workbench-drawer" aria-label={title}
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="a-drawer-heading"><h2>{title}</h2><button type="button" autoFocus onClick={onClose} aria-label="关闭面板"><X size={19} /></button></div>
    <div className="a-drawer-body">{children}</div>
  </dialog>;
}

function GenerationWorkspace({ projectId }: { projectId: string }) {
  const api = getApiWorkspace();
  const { user } = useWorkspaceAuth();
  const ui = useUiPreferences();
  const ownerId = user!.id;
  const state = useGenerationState(projectId);
  const models = useMemo(() => createModelsApi(api), [api]);
  const tasksLoader = useCallback(() => state.generation.listTasks(), [state.generation]);
  const tasksQuery = usePrivateQuery(tasksLoader);
  const refreshTasks = tasksQuery.refresh;
  const tasks = useMemo(() => tasksQuery.data ?? [], [tasksQuery.data]);
  const taskSummary = useMemo(() => summarizeTasks(tasks), [tasks]);
  const modelsLoader = useCallback(() => models.list(), [models]);
  const modelQuery = usePrivateQuery(modelsLoader);
  const [selectedModelId, setSelectedModelId] = useState(() => readSessionModel(ownerId, projectId)?.profileId ?? "");
  const selectedModel = modelQuery.data?.find((model) => model.id === selectedModelId)
    ?? modelQuery.data?.find((model) => model.isDefault) ?? modelQuery.data?.[0];
  // Session-level model override: the catalog model the user picked under this
  // provider credential, persisted for the current browser session. Omitted
  // means "use the credential's default model", which is also frozen per run.
  const [modelOverrideId, setModelOverrideId] = useState<string | null>(() => readSessionModel(ownerId, projectId)?.modelId ?? null);
  const [customModelMode, setCustomModelMode] = useState(false);
  // Matches the server's admission requirements: a profile that has not passed
  // the image test is refused with MODEL_VISION_NOT_VERIFIED, so it is not
  // offered as ready here either.
  const modelReady = selectedModel?.capabilities.streaming === "verified"
    && selectedModel.capabilities.tools === "verified" && selectedModel.capabilities.vision === "verified";
  /** Models available on the selected credential's endpoint: Pi's catalog for
   * built-in providers, the endpoint's own `/models` list for custom ones. */
  const profileModelsLoader = useCallback(() => {
    const profileId = selectedModel?.id;
    if (!profileId) return Promise.resolve({ source: "none" as const, models: [] });
    return models.forProfile(profileId);
  }, [models, selectedModel?.id]);
  const profileModelsQuery = usePrivateQuery(profileModelsLoader);
  const credentialModels = useMemo(() => profileModelsQuery.data?.models ?? [], [profileModelsQuery.data]);
  // The effective model for the next run: an explicit override wins, otherwise
  // the credential's default model. Catalog ids and free-text (unlisted) ids
  // are both frozen on the run.
  const inCatalog = !!modelOverrideId && credentialModels.some((model) => model.id === modelOverrideId);
  const effectiveModelId = modelOverrideId && (customModelMode || inCatalog) ? modelOverrideId : selectedModel?.modelId ?? null;
  const [draft, setDraft] = useState(() => readDraft(ownerId, projectId));
  const draftRef = useRef(draft);
  const [draftStored, setDraftStored] = useState(true);
  const [pending, setPending] = useState(false);
  const sending = useRef(false);
  const [unknownSubmission, setUnknownSubmission] = useState<RunSubmission | null>(() => readPendingSubmission(ownerId, projectId));
  // Read the flag when the effect runs, not when the component mounts. The create page
  // reaches this route with router.push, and this component can mount before the new
  // query string is visible, so a mount-time snapshot stayed false and the saved first
  // requirement was never submitted: the project appeared with its draft in the composer
  // and ?start=1 still in the address bar. The ref now only records that the one-shot
  // submission already happened.
  const autoStarted = useRef(false);
  const [submitError, setSubmitError] = useState("");
  const [stopping, setStopping] = useState(false);
  const [stoppingTaskId, setStoppingTaskId] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publicationError, setPublicationError] = useState("");
  const [actionError, setActionError] = useState("");
  const [drawer, setDrawer] = useState<"history" | "checks" | "publish" | "tasks" | null>(null);
  const [hashNotice, setHashNotice] = useState("");
  const [mobileTab, setMobileTab] = useState<"chat" | "result">("chat");
  const [collapsed, setCollapsed] = useState(false);
  const [candidateBase, setCandidateBase] = useState<CandidateBaseSelection | null>(() => readCandidateBase(ownerId, projectId));
  const [candidateBaseStored, setCandidateBaseStored] = useState(true);
  const [selectedRevisionId, setSelectedRevisionId] = useState(() => readCandidateBase(ownerId, projectId)?.revisionId ?? "");
  const [comparisonTarget, setComparisonTarget] = useState<{ from: string; to: string; key: string } | null>(null);
  const project = state.view?.project;
  const run = state.view?.run;
  const historyApi = useMemo(() => createVersionHistoryApi(api), [api]);
  const historyLoader = useCallback(() => historyApi.list(projectId), [historyApi, projectId]);
  const historyQuery = usePrivateQuery(historyLoader);
  const { refresh: refreshHistory } = historyQuery;
  const historyCurrentId = project?.project.currentRevisionId;
  const historyCandidateId = project?.latestCandidate?.id;
  useEffect(() => { if (historyCurrentId !== undefined) refreshHistory(); }, [historyCurrentId, historyCandidateId, run?.state, refreshHistory]);
  // The owner task list is the single source for real queue positions: re-read it
  // when the visible run changes state, and poll only while work is still open.
  useEffect(() => { refreshTasks(); }, [run?.state, refreshTasks]);
  useEffect(() => {
    if (!taskSummary.open) return;
    const timer = setInterval(() => refreshTasks(), 4000);
    return () => clearInterval(timer);
  }, [taskSummary.open, refreshTasks]);
  const diffLoader = useCallback(() => comparisonTarget
    ? historyApi.compare(projectId, comparisonTarget.from, comparisonTarget.to) : Promise.resolve(null),
  [historyApi, projectId, comparisonTarget]);
  const diffQuery = usePrivateQuery(diffLoader);
  const cancellation = useCancellationRequestLatch({ runId: run?.id, isActive: state.active, isCancellationSettling: run?.state === "cancel_requested" });
  const clarification = run?.state === "needs_input" ? run.clarification : null;
  const lockedProfile = state.active && run ? modelQuery.data?.find((model) => model.id === run.modelProfileId && model.configVersion === run.modelConfigVersion) : null;
  const savedHistory = !!historyQuery.data && historyQuery.data.currentRevisionId === project?.project.currentRevisionId
    && (!project?.latestCandidate || historyQuery.data.revisions.some((item) => item.id === project.latestCandidate!.id));
  const revisions: Revision[] = savedHistory ? historyQuery.data!.revisions
    : [project?.currentRevision, project?.latestCandidate].filter((item): item is Revision => !!item);
  const revision = revisions.find((item) => item.id === selectedRevisionId) ?? project?.currentRevision ?? project?.latestCandidate ?? null;
  const selectedBase = candidateBase ? revisions.find((item) => item.id === candidateBase.revisionId && item.buildStatus === "passed" && item.status !== "accepted") : null;
  const selectedBaseStale = !!candidateBase && candidateBase.expectedCurrentRevisionId !== project?.project.currentRevisionId;
  const runRevision = revisions.find((item) => item.id === run?.resultRevisionId);
  const runCheck = project?.latestCheck && runRevision && project.latestCheck.runId === run?.id && checkMatchesRevision(project.latestCheck, runRevision) ? project.latestCheck : null;
  const snapshotCheck = project?.latestCheck && revision && checkMatchesRevision(project.latestCheck, revision) ? project.latestCheck : null;
  const selectedCheckLoader = useCallback(async () => {
    if (!revision) return null;
    const check = snapshotCheck ?? await state.generation.getCheck(revision.id);
    if (check && !checkMatchesRevision(check, revision)) throw new Error("检查记录与所选源码版本不一致，请重新读取。");
    return check;
  // A historical selection has its own Check; the latest project Check is only a fast path.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision?.id, revision?.sourceHash, revision?.runId, revision?.attempt, snapshotCheck?.id, state.generation]);
  const selectedCheckQuery = usePrivateQuery(selectedCheckLoader);
  const selectedCheck = snapshotCheck ?? selectedCheckQuery.data;
  const checkBadge = selectedCheckQuery.error ? "检查异常" : selectedCheck?.groups ? `${selectedCheck.groups.filter((group) => group.verdict === "passed").length}/${selectedCheck.groups.length}`
    : selectedCheck?.verdict === "passed" ? "已通过" : "检查";
  const snapshotPreview = project?.preview;
  const revisionId = revision?.id;
  const hasSnapshotPreview = !!snapshotPreview && snapshotPreview.revisionId === revisionId && snapshotPreview.sourceHash === revision?.sourceHash;
  const previewLoader = useCallback(async () => {
    if (!revisionId || hasSnapshotPreview) return null;
    return state.generation.getPreview(projectId, revisionId);
  }, [projectId, revisionId, hasSnapshotPreview, state.generation]);
  const previewQuery = usePrivateQuery(previewLoader);
  const publicationLoader = useCallback(() => state.generation.getPublication(projectId), [projectId, state.generation]);
  const publicationQuery = usePrivateQuery(publicationLoader);
  const refreshPreview = previewQuery.refresh;
  const refreshPublication = publicationQuery.refresh;
  const refreshProject = state.refresh;
  const onRollbackCommitted = useCallback(async (targetRevisionId: string) => {
    setCandidateBase(null); saveCandidateBase(ownerId, projectId, null);
    setSelectedRevisionId(targetRevisionId);
    setComparisonTarget(null);
    await refreshProject();
    refreshHistory();
    refreshPreview();
    refreshPublication();
  }, [ownerId, projectId, refreshProject, refreshHistory, refreshPreview, refreshPublication]);
  const rollback = useRollback({ api, ownerId, projectId, onCommitted: onRollbackCommitted });
  const busy = pending || state.active || run?.cleanupState === "pending" || rollback.busy;
  const queued = run?.state === "queued";
  const queuedTask = tasks.find((task) => task.runId === run?.id && task.state === "queued");
  const queuedPosition = queuedTask?.queuePosition ?? null;
  // Queueing is a capability of the deployed API: without the owner task list
  // the composer keeps the old rule and waits for the executing task.
  const queueEnabled = !!tasksQuery.data;
  // A task that is already executing no longer blocks the next request: the new
  // one is persisted and queued. Only an unconfirmed submission, a pending
  // cleanup or a rollback in flight keeps the composer closed.
  const submissionBlocked = pending || !!unknownSubmission || run?.cleanupState === "pending" || rollback.busy
    || (!!candidateBase && (!selectedBase || selectedBaseStale))
    || (!queueEnabled && state.active);
  const tooLong = draft.trim().length > promptLimit;
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => { bottom.current?.scrollIntoView?.({ block: "nearest" }); }, [project?.messages.length, run?.state]);

  function editDraft(value: string) {
    draftRef.current = value; setDraft(value); setDraftStored(saveDraft(ownerId, projectId, value));
  }
  function chooseCandidateBase(value: Revision | null) {
    const selection = value ? { revisionId: value.id, expectedCurrentRevisionId: project!.project.currentRevisionId } : null;
    setCandidateBase(selection); setCandidateBaseStored(saveCandidateBase(ownerId, projectId, selection));
    setSelectedRevisionId(value?.id ?? project?.project.currentRevisionId ?? "");
    setDrawer(null);
  }
  async function send(replay?: RunSubmission) {
    if (sending.current || (!replay && (submissionBlocked || !draft.trim() || tooLong || !modelReady || !selectedModel || !project))) return;
    // The run freezes (profileId, configVersion, modelId). The model override is
    // only serialized when it differs from the credential's default; otherwise
    // the frozen version row already pins the default model.
    const overrideModelId = effectiveModelId && selectedModel && effectiveModelId !== selectedModel.modelId ? effectiveModelId : null;
    const submission: RunSubmission = replay ?? {
      key: crypto.randomUUID(),
      body: { text: draft.trim(), expectedCurrentRevisionId: candidateBase ? candidateBase.expectedCurrentRevisionId : project!.project.currentRevisionId,
        ...(candidateBase ? { selectedBaseRevisionId: candidateBase.revisionId } : {}),
        modelProfileId: selectedModel!.id, modelConfigVersion: selectedModel!.configVersion,
        ...(overrideModelId ? { modelId: overrideModelId } : {}),
        retryOfRunId: null, parentRunId: clarification && run ? run.id : null },
    };
    sending.current = true; setPending(true); setSubmitError("");
    const persisted = savePendingSubmission(ownerId, projectId, submission);
    try {
      const accepted = await state.generation.start(projectId, submission);
      clearPendingSubmission(ownerId, projectId); setUnknownSubmission(null);
      if (submission.body.selectedBaseRevisionId) chooseCandidateBase(null);
      // A response for the previous text must not erase a newly edited draft.
      if (draftRef.current.trim() === submission.body.text) editDraft("");
      await state.accepted(accepted.runId);
    } catch (reason) {
      const rejected = reason instanceof WorkspaceError && (rejectedSubmissions.has(reason.code)
        || !!reason.httpStatus && reason.httpStatus >= 400 && reason.httpStatus < 500);
      if (rejected) { clearPendingSubmission(ownerId, projectId); setUnknownSubmission(null); }
      else setUnknownSubmission(submission);
      setSubmitError(`${errorMessage(reason)}${!rejected && !persisted ? " 请保持页面打开，以确认上次提交结果。" : ""}`);
      if (reason instanceof WorkspaceError && ["PROJECT_BUSY", "STALE_BASE", "CLEANUP_PENDING"].includes(reason.code)) void state.refresh();
    } finally { sending.current = false; setPending(false); }
  }

  useEffect(() => {
    if (autoStarted.current) return;
    if (typeof window === "undefined" || new URLSearchParams(window.location.search).get("start") !== "1") return;
    if (!project || run || busy || unknownSubmission || !modelReady || !selectedModel || !draft.trim()) return;
    autoStarted.current = true;
    const url = new URL(window.location.href);
    url.searchParams.delete("start");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    // Deferred by a microtask so the effect does not synchronously trigger the submitting
    // state, which the lint rule forbids to avoid cascading renders.
    void Promise.resolve().then(() => send());
  // New projects submit their saved initial draft once after project and verified model load.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.project.id, run?.id, busy, unknownSubmission, modelReady, selectedModel?.id, draft]);

  const canStop = state.active && !!run && run.state !== "cancel_requested";
  const composerStatus = cancellation.isCancellationRequested || stopping
    ? ui.text("正在停止：等待远端模型与沙箱清理确认", "Stopping: waiting for the model and sandbox to finish cleanup")
    : run?.state === "repairing" ? ui.text(`检查未通过，正在自动修复（第 ${run.attempt + 1} 轮）`, `Fixing checks automatically (attempt ${run.attempt + 1})`)
      : queued ? ui.text(queuedPosition ? `已排队（第 ${queuedPosition} 位），资源可用后自动开始` : "已排队，资源可用后自动开始", queuedPosition ? `Queued (position ${queuedPosition}) · starts automatically` : "Queued · starts automatically")
      : state.active ? ui.text(queueEnabled ? "正在执行；下一条需求会加入队列" : "正在执行，可以继续写草稿", queueEnabled ? "Running · The next request joins the queue" : "Running · You can keep drafting")
        : run?.cleanupState === "pending" ? ui.text("正在清理执行资源", "Cleaning up execution resources")
          : clarification ? ui.text("回答后继续原需求", "Answer to continue your request") : ui.text("准备好你的下一个想法", "Ready for your next idea");
  const quotaFull = !!project?.quota && project.quota.dailyAccepted >= project.quota.dailyLimit;
  async function stop() {
    if (!run || !cancellation.requestCancellation()) return;
    setStopping(true); setActionError("");
    try { await state.generation.cancel(run.id); await state.refresh(); }
    catch (reason) { cancellation.releaseRejectedRequest(); setActionError(errorMessage(reason)); }
    finally { setStopping(false); }
  }
  /** The same cancel endpoint, driven from the owner task list instead of the
   * run currently shown in the workbench. */
  async function cancelTask(task: TaskListItem) {
    if (stoppingTaskId) return;
    setStoppingTaskId(task.runId); setActionError("");
    try { await state.generation.cancel(task.runId); await state.refresh(); refreshTasks(); }
    catch (reason) { setActionError(errorMessage(reason)); }
    finally { setStoppingTaskId(null); }
  }
  /** Retry creates a new run that links to the failed one; the old record stays. */
  async function retry() {
    if (sending.current || !run || !project || !selectedModel) return;
    await send({ key: crypto.randomUUID(),
      body: { text: run.requestText, expectedCurrentRevisionId: project.project.currentRevisionId,
        modelProfileId: selectedModel.id, modelConfigVersion: selectedModel.configVersion,
        ...(effectiveModelId && effectiveModelId !== selectedModel.modelId ? { modelId: effectiveModelId } : {}),
        retryOfRunId: run.id, parentRunId: null } });
  }
  /** Rebuilds a preview from the saved snapshot; it never calls a model. */
  async function restore() {
    if (!revision || restoring || rollback.busy) return;
    setRestoring(true); setActionError("");
    try {
      await state.generation.restorePreview(projectId, revision.id);
      // Poll until the service reports a terminal preview state for this version.
      for (let attempt = 0; attempt < 60; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        const preview = await state.generation.getPreview(projectId, revision.id);
        if (preview && preview.state !== "restoring") break;
      }
      await state.refresh(); previewQuery.refresh();
    } catch (reason) { setActionError(errorMessage(reason)); }
    finally { setRestoring(false); }
  }
  async function publish() {
    const current = project?.currentRevision;
    if (!current || publishing || state.active || rollback.busy) return;
    setPublishing(true); setPublicationError("");
    try {
      let preview = await state.generation.getPreview(projectId, current.id);
      if (preview?.state !== "ready") {
        await state.generation.restorePreview(projectId, current.id);
        for (let attempt = 0; attempt < 60; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 3000));
          preview = await state.generation.getPreview(projectId, current.id);
          if (preview?.state === "ready") break;
          if (preview?.state !== "restoring") throw new Error(preview?.error ?? "预览恢复失败，请重试。");
        }
      }
      if (preview?.state !== "ready") throw new Error("预览恢复超时，请稍后重试。");
      await state.generation.publish(projectId);
      publicationQuery.refresh();
      await state.refresh();
    } catch (reason) {
      // Each refusal has one thing the user can actually do about it; a raw
      // message leaves them guessing which.
      const code = reason instanceof WorkspaceError ? reason.code : "";
      setPublicationError({
        PUBLICATION_UNAVAILABLE: "永久发布尚未在这台服务器上配置；请联系维护者，或继续使用临时预览。",
        NO_ACCEPTED_REVISION: "项目还没有通过检查的版本，先完成一次通过检查的生成再发布。",
        REVISION_NOT_VERIFIED: "当前版本尚未通过检查，不能发布。请在检查抽屉确认结论后重试。",
        PREVIEW_NOT_READY: "发布前需要当前版本有一个可用预览。请点击「重新启动预览」，等它就绪后再发布。",
      }[code] ?? errorMessage(reason));
    }
    finally { setPublishing(false); }
  }
  async function copySourceHash() {
    if (!revision) return;
    try { await navigator.clipboard.writeText(revision.sourceHash); setHashNotice("源码 hash 已复制"); }
    catch { setHashNotice("无法自动复制；可在版本历史中查看完整 hash"); }
  }

  if (!project && state.error) return <><AppHeader /><main className="standalone-state"><TriangleAlert size={30} /><h1>{ui.text("暂时无法打开这个项目", "This project is temporarily unavailable")}</h1><p role="alert">{state.error}</p><div className="inline-actions"><Button variant="outline" onClick={() => void state.refresh()}>{ui.text("重新加载", "Reload")}</Button><Button asChild><Link href="/projects">{ui.text("返回我的项目", "Back to projects")}</Link></Button></div></main></>;
  if (!project) return <><AppHeader /><div className="page-loader" aria-label={ui.text("正在打开项目", "Opening project")}><LoaderCircle className="spin" size={24} /></div></>;
  const toolbarExtras = <>
    {revision && <>
      <button type="button" className="a-toolbar-version" onClick={() => setDrawer("history")} aria-label={`版本历史，正在查看 v${revision.revisionNo}`}>
        v{revision.revisionNo}<span>{revision.id === project.project.currentRevisionId ? "当前" : revision.status !== "accepted" ? "候选" : "历史"}</span><ChevronDown size={12} />
      </button>
      {/* Viewing a historical version must never hide which version is really
          current: the two are labelled separately, and this returns to it. */}
      {revision.id !== project.project.currentRevisionId && project.currentRevision && <button type="button" className="a-toolbar-current" onClick={() => setSelectedRevisionId(project.currentRevision!.id)} aria-label={`回到当前版本 v${project.currentRevision.revisionNo}`}>
        {ui.text("当前", "Current")} v{project.currentRevision.revisionNo}<code>{project.currentRevision.sourceHash.slice(0, 8)}</code>
      </button>}
      <button type="button" className="a-toolbar-hash" title={revision.sourceHash} onClick={() => void copySourceHash()} aria-label="复制完整源码 hash">
        <span>hash</span><code data-testid="workbench-source-hash-short">{revision.sourceHash.slice(0, 8)}</code><Copy size={12} />
      </button>
      <button type="button" className="a-toolbar-icon" title="版本历史" aria-label="版本历史" onClick={() => setDrawer("history")}><History size={16} /></button>
      <button type="button" className="a-toolbar-check" aria-label={`检查结果 ${checkBadge}`} onClick={() => setDrawer("checks")}><Check size={14} />{project.latestCheckHistorical && revision.id === project.project.currentRevisionId ? "历史检查" : checkBadge}</button>
      {revision.status !== "accepted" && revision.buildStatus === "passed" && <Button type="button" variant="outline" size="sm"
        disabled={busy || !!unknownSubmission} aria-label={`从候选 v${revision.revisionNo} 继续开发`}
        aria-pressed={candidateBase?.revisionId === revision.id}
        onClick={() => chooseCandidateBase(revision)}>{candidateBase?.revisionId === revision.id ? "已设为继续基线" : "从此候选继续"}</Button>}
    </>}
    {project.latestCandidate && project.latestCandidate.id !== revision?.id && <Button type="button" variant="outline" size="sm"
      aria-label={`查看候选 v${project.latestCandidate.revisionNo}`} onClick={() => setSelectedRevisionId(project.latestCandidate!.id)}>查看候选 v{project.latestCandidate.revisionNo}</Button>}
    {project.currentRevision && <button type="button" className="a-toolbar-publish" onClick={() => setDrawer("publish")}>发布<ChevronDown size={12} /></button>}
    {hashNotice && <span className="a-toolbar-notice" role="status">{hashNotice}</span>}
  </>;
  return <div className="workbench-page a-workbench-page">
    <AppHeader title={project.project.title} saving={state.active}>
      {tasksQuery.data && <button type="button" className="settings-header-link a-header-tasks" onClick={() => setDrawer("tasks")} aria-label={ui.text("我的任务", "My tasks")}>
        <ListChecks size={15} /><span className="a-header-tasks-label">{ui.text("任务", "Tasks")}</span>
        {taskSummary.open + taskSummary.attention > 0 && <span className="a-header-task-count" data-testid="header-task-count">{taskSummary.open + taskSummary.attention}</span>}
      </button>}
    </AppHeader>
    <nav className="mobile-workbench-tabs" aria-label={ui.text("工作区", "Workspace")}><button aria-pressed={mobileTab === "chat"} onClick={() => setMobileTab("chat")}><MessageSquare size={15} />{ui.text("对话", "Chat")}{state.active && <span className="mini-dot" />}</button><button aria-pressed={mobileTab === "result"} onClick={() => setMobileTab("result")}><Monitor size={15} />{ui.text("结果", "Result")}{revision && <span>v{revision.revisionNo}</span>}</button></nav>
    <main className={cn("workbench-layout", `mobile-show-${mobileTab}`, collapsed && "chat-collapsed")}>
      <section className="chat-panel" aria-label={ui.text("与 Pivloom 对话", "Chat with Pivloom")}>
        <div className="chat-panel-heading"><div><strong>{ui.text("对话", "Chat")}</strong><span className="conversation-badge">{ui.text("让想法继续生长", "Let ideas grow")}</span></div><button className="icon-button collapse-button" onClick={() => setCollapsed(true)} aria-label={ui.text("收起对话", "Collapse chat")}><PanelLeftClose size={16} /></button></div>
        <div className="chat-scroll">
          {project.messages.length === 0 ? <div className="chat-welcome"><LoomMark /><h2>{ui.text("想法已经就位", "Your idea starts here")}</h2><p>{ui.text("描述你想实现的功能，用自己的模型开始构建。", "Describe what you want and build it with your model.")}</p></div>
            : project.messages.filter((message) => !(clarification && message.kind === "question" && message.runId === run?.id)).map((message) => message.kind === "user" ? <article className="user-message" key={message.id}><div>{message.content}</div></article>
              : message.kind === "rollback" ? <article className="rollback-message" data-testid="rollback-conversation-event" key={message.id}><RotateCcw size={15} aria-hidden="true" /><div><strong>{ui.text("版本回滚", "Version rollback")}</strong><p>{message.content}</p></div></article>
              : <article className="assistant-message" key={message.id}><div className="assistant-message-heading"><LoomMark /><strong>{message.kind === "question" ? ui.text("协调者", "Coordinator") : "Pivloom"}</strong></div><div className="assistant-message-body"><p className="message-content">{message.content}</p></div></article>)}
          {run && <GenerationActivity run={run} events={state.view!.events} roles={state.view!.roles} />}
          {run?.selectedBaseRevisionId && <p className="previous-version-note" data-testid="run-candidate-base">
            本轮基线：候选 {revisions.find((item) => item.id === run.selectedBaseRevisionId) ? `v${revisions.find((item) => item.id === run.selectedBaseRevisionId)!.revisionNo}` : run.selectedBaseRevisionId.slice(0, 8)}；继续开发不代表该候选已验收。
          </p>}
          {run && <GenerationOutcome run={run} candidateSaved={project.latestCandidate?.runId === run.id && project.latestCandidate.id === run.resultRevisionId} check={runCheck} failureDetail={state.view?.failureDetail ?? null} />}
          <div ref={bottom} />
        </div>
        <div className="chat-bottom">
          {state.active && <p className={cn("generation-connection", (state.connection === "polling" || state.connection === "unavailable") && "generation-connection-warning")} role="status">{state.connection === "awaiting_snapshot" ? "需求已接收，正在读取任务状态。" : state.connection === "unavailable" ? "任务不存在或无权访问，已停止重连。" : state.connection === "polling" ? "实时连接暂不可用，正在定时读取任务状态。" : state.connection === "connected" ? "已连接实时执行记录" : "正在连接实时执行记录…"}{state.connection === "unavailable" && <button className="generation-inline-retry" onClick={() => void state.refresh()}>重新读取任务</button>}</p>}
          {state.error && <p className="inline-error" role="alert">{state.error}<button className="generation-inline-retry" onClick={() => void state.refresh()}>重新读取</button></p>}
          {taskSummary.open > 1 && <p className="generation-queue-note" role="status">
            {ui.text(`另有 ${taskSummary.open - 1} 个任务在执行或排队${taskSummary.position ? `（最近的排队位置 ${taskSummary.position}）` : ""}。`,
              `${taskSummary.open - 1} more task(s) running or queued${taskSummary.position ? ` (position ${taskSummary.position})` : ""}.`)}
            <button type="button" className="generation-inline-retry" onClick={() => setDrawer("tasks")}>{ui.text("查看任务", "View tasks")}</button>
          </p>}
          {actionError && <p className="inline-error" role="alert">{actionError}</p>}
          {/* A task parked by the scheduler is retryable; a task waiting for the
              user's answer is not, and offering retry there would contradict the
              clarification question shown next to it. */}
          {!state.active && run && run.error?.retryable && !run.clarification?.question && <p className="generation-retry-row" role="status">{run.error.message}<Button variant="outline" size="sm" disabled={pending || !modelReady} onClick={() => void retry()}>以新任务重试</Button></p>}
          {submitError && <p className="inline-error" role="alert">{submitError}</p>}
          {unknownSubmission && <div className="run-notice" role="status"><div><strong>{ui.text("上次提交的结果尚未确认", "Previous submission is not confirmed")}</strong><p>{ui.text("确认会沿用原请求，不会把正在编辑的草稿重复发送。", "Confirming reuses the original request without sending your draft twice.")}</p></div><button disabled={pending} onClick={() => void send(unknownSubmission)}>{ui.text("确认提交结果", "Confirm submission")}</button></div>}
          {!state.active && (modelQuery.error || modelQuery.data && !modelReady) && <p className="generation-model-help" role="status">{modelQuery.error || (selectedModel ? "此配置尚未通过流式和工具调用测试。" : "先连接并测试你要使用的模型。")}{" "}<Link href="/settings/models">前往模型设置</Link></p>}
          <form className={cn("chat-composer", state.active && "composer-running")} onSubmit={(event) => { event.preventDefault(); void send(); }}>
            <label className="sr-only" htmlFor="followup-prompt">{clarification ? ui.text("回答澄清问题", "Answer clarification") : ui.text("应用需求", "App request")}</label>
            <textarea id="followup-prompt" value={draft} onChange={(event) => editDraft(event.target.value)} placeholder={state.active && !clarification ? ui.text(queueEnabled ? "继续写下一条需求，提交后会加入队列…" : "可以先写下一条需求，任务结束后再发送…", queueEnabled ? "Describe the next change; it joins the queue…" : "Draft the next request while this run finishes…") : clarification ? ui.text("回答上面的问题，继续原需求…", "Answer the question to continue…") : ui.text("描述你想实现或修改的功能…", "Describe what you want to build or change…")} aria-invalid={tooLong} aria-describedby={[tooLong ? "draft-error" : "", clarification ? "clarification-question" : ""].filter(Boolean).join(" ") || undefined} onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void send(); }
            }} />
            <div className="chat-composer-controls generation-composer-controls">
              <div className="composer-meta">
                <span className="composer-status" role="status"><span className="small-status-dot" aria-hidden="true" />{composerStatus}</span>
                {project.quota && <span className="generation-quota">{ui.text("今日额度", "Daily allowance")} <strong>{project.quota.dailyAccepted}/{project.quota.dailyLimit}</strong></span>}
              </div>
              <div className="composer-toolbar">
                <div className="composer-model"><SessionModelPicker profiles={modelQuery.data} selectedProfileId={selectedModel?.id} catalog={credentialModels} effectiveModelId={effectiveModelId} lockedLabel={state.active && run ? `${lockedProfile?.name ?? "已保存配置"} · ${run.modelId ?? lockedProfile?.modelId ?? "模型"} · v${run.modelConfigVersion}` : undefined} disabled={pending || state.active} onProfile={(id) => { const next = modelQuery.data?.find((profile) => profile.id === id); setSelectedModelId(id); setModelOverrideId(null); setCustomModelMode(false); if (next) saveSessionModel(ownerId, projectId, id, next.modelId); }} onModel={(id) => { if (!selectedModel) return; setCustomModelMode(false); setModelOverrideId(id); saveSessionModel(ownerId, projectId, selectedModel.id, id); }} onCustom={(id) => { if (!selectedModel) return; setCustomModelMode(true); setModelOverrideId(id); saveSessionModel(ownerId, projectId, selectedModel.id, id); }} onRefresh={modelQuery.refresh} /></div>
                <div className="composer-actions">{canStop && <Button type="button" variant="outline" size="sm" disabled={stopping || cancellation.isCancellationRequested} onClick={() => void stop()} aria-label={ui.text(queued ? "取消排队" : "停止任务", queued ? "Cancel queued task" : "Stop run")}>{stopping || cancellation.isCancellationRequested ? <><LoaderCircle className="spin" size={14} />{ui.text("正在停止", "Stopping")}</> : ui.text(queued ? "取消排队" : "停止", queued ? "Cancel" : "Stop")}</Button>}<Button type="submit" size="icon" disabled={submissionBlocked || !draft.trim() || tooLong || !modelReady} aria-label={clarification ? ui.text("发送回答", "Send answer") : ui.text("发送需求", "Send request")}>{pending ? <LoaderCircle className="spin" size={16} /> : <ArrowUp size={18} />}</Button></div>
              </div>
            </div>
          </form>
          {quotaFull && <p className="generation-model-help" role="status">今日任务额度已用完（{project.quota!.dailyLimit} 个），请明日再试或联系维护者。</p>}
          {tooLong && <p id="draft-error" className="inline-error" role="alert">需求最多 {promptLimit.toLocaleString()} 个字符。</p>}
          <div className="composer-hint"><span>{draftStored ? ui.text("Enter 发送 · Shift + Enter 换行", "Enter to send · Shift + Enter for a new line") : ui.text("草稿未保存，请保持页面打开", "Draft not saved; keep this page open")}</span><span>{draft.length} / {promptLimit}</span></div>
        </div>
      </section>
      <div className="generation-result-shell">
        {candidateBase && <div className="candidate-base-selection" role="status">
          <span>{selectedBase ? `继续基线：候选 v${selectedBase.revisionNo} · 未验收` : "已保存的候选选择暂不可用，请重新选择"}
          {selectedBaseStale ? " · 当前已验收版本已变化，请重新确认候选" : " · 当前已验收与已发布版本不变"}
          {!candidateBaseStored && " · 选择未保存，请保持页面打开"}</span>
          <Button variant="ghost" size="sm" onClick={() => chooseCandidateBase(null)}>使用当前已验收版本</Button>
        </div>}
        {collapsed && <button className="generation-expand-chat icon-button" aria-label={ui.text("展开对话", "Expand chat")} onClick={() => setCollapsed(false)}><PanelLeftOpen size={16} /></button>}
        {previewQuery.error && <p className="inline-error" role="alert">{previewQuery.error}</p>}
        <GenerationResult projectId={projectId} revision={revision} preview={hasSnapshotPreview ? snapshotPreview! : previewQuery.data ?? null} generation={state.generation} active={state.active} queued={queued} latestCheck={project.latestCheck} historicalCheck={revision?.status === "accepted" && (revision.id !== project.project.currentRevisionId || !!project.latestCheckHistorical)} checking={state.active && run?.phase === "review" && revision?.runId === run.id} restoring={restoring || (previewQuery.data?.state === "restoring" && previewQuery.data.revisionId === revision?.id)} onRestore={busy ? undefined : () => void restore()} toolbarExtras={toolbarExtras} showReview={false} />
      </div>
    </main>
    <DeploymentVersion />
    {drawer === "history" && <WorkbenchDrawer key="history" title="版本历史" onClose={() => setDrawer(null)}>
      {revisions.length ? <VersionHistoryPanel revisions={revisions} currentRevisionId={project.project.currentRevisionId} selectedRevision={revision}
        messages={project.messages} historyError={historyQuery.error} currentFromRollback={!!project.latestCheckHistorical}
        onSelect={(id) => { setSelectedRevisionId(id); setComparisonTarget(null); }}
        onCompare={(from, to) => setComparisonTarget({ from, to, key: crypto.randomUUID() })}
        comparison={comparisonTarget?.to === revision?.id ? diffQuery.data ?? null : null}
        comparing={!!comparisonTarget && !diffQuery.data && !diffQuery.error}
        comparisonError={comparisonTarget?.to === revision?.id ? diffQuery.error : ""}
        rollback={{ busy: rollback.busy, unknown: rollback.unknown,
          disabled: busy || !!unknownSubmission || publishing || restoring,
          operation: rollback.operation, error: rollback.error, storageWarning: rollback.storageWarning,
          start: (target, from) => { void rollback.start(target, from); },
          confirm: () => { void rollback.confirm(); }, cancel: () => { void rollback.cancel(); },
          clearResult: rollback.clearResult }} /> : <p>还没有保存的版本。</p>}
    </WorkbenchDrawer>}
    {drawer === "checks" && <WorkbenchDrawer key="checks" title="检查结果" onClose={() => setDrawer(null)}>
      {revision ? <>{revision.id !== project.project.currentRevisionId ? <p className="a-drawer-context">正在查看{revision.status === "accepted" ? "历史" : "候选"} v{revision.revisionNo} 的检查记录；当前版本不会因此改变。</p>
        : project.latestCheckHistorical ? <p className="a-drawer-context">这是回滚目标原 Run 的历史检查；重建后的预览尚未重新验收。</p> : null}
        <GenerationReview key={`${revision.id}:${state.active}`} revision={revision} latestCheck={project.latestCheck} generation={state.generation} checking={state.active && run?.phase === "review" && revision.runId === run.id} /></> : <p>生成首个版本后可查看检查结果。</p>}
    </WorkbenchDrawer>}
    {drawer === "publish" && <WorkbenchDrawer key="publish" title="发布作品" onClose={() => setDrawer(null)}>
      {project.currentRevision && <div className="a-publish-panel"><div className="a-publish-icon"><ExternalLink size={26} /></div><h3>让作品拥有自己的地址</h3>
        <p>{publicationQuery.data?.revisionId === project.currentRevision.id ? "当前版本已永久发布；工作台上的预览仍是会到期的临时预览。" : publicationQuery.data ? "已发布作品仍是之前的版本；回滚不会自动更新它。" : "工作台上的预览是会到期的临时预览；正式发布后可用独立域名长期访问。"}</p>
        <div className="a-publish-version"><span>当前源码版本</span><strong>v{project.currentRevision.revisionNo}<code>{project.currentRevision.sourceHash.slice(0, 8)}</code></strong></div>
        {/* Which revision the permanent site actually serves. It is not always
            the current one, and the user cannot tell them apart otherwise. */}
        {publicationQuery.data && (() => {
          const published = revisions.find((item) => item.id === publicationQuery.data!.revisionId);
          return <div className="a-publish-version" data-testid="published-version">
            <span>已发布版本</span>
            <strong>{published ? `v${published.revisionNo}` : "已发布"}<code>{publicationQuery.data!.sourceHash.slice(0, 8)}</code></strong>
            {published && published.id !== project.currentRevision!.id ? <em>与当前版本不同</em> : null}
          </div>;
        })()}
        {publicationQuery.data && <a className="a-published-link" href={publicationQuery.data.url} target="_blank" rel="noopener noreferrer">访问已发布作品<ExternalLink size={15} /></a>}
        {publicationQuery.data?.revisionId !== project.currentRevision.id && <Button disabled={publishing || busy} onClick={() => void publish()}>{publishing ? <><LoaderCircle className="spin" size={14} />正在发布…</> : publicationQuery.data ? "发布当前新版本" : "永久发布当前版本"}</Button>}
        {(publicationError || publicationQuery.error) && <p className="inline-error" role="alert">{publicationError || publicationQuery.error}</p>}
      </div>}
    </WorkbenchDrawer>}
    {drawer === "tasks" && <WorkbenchDrawer key="tasks" title={ui.text("我的任务", "My tasks")} onClose={() => setDrawer(null)}>
      <p className="a-drawer-context">{ui.text("这里只显示你自己的任务。排队中的任务不占用沙箱，取消后不会执行。",
        "Only your own tasks appear here. Queued tasks hold no sandbox and cancelling never starts them.")}</p>
      {tasksQuery.error ? <p className="inline-error" role="alert">{tasksQuery.error}</p>
        : <TaskQueuePanel tasks={tasks} stoppingId={stoppingTaskId} onCancel={(task) => void cancelTask(task)} />}
    </WorkbenchDrawer>}
  </div>;
}
export function ApiWorkbench({ projectId }: { projectId: string }) { return <AuthGate><GenerationWorkspace key={projectId} projectId={projectId} /></AuthGate>; }
