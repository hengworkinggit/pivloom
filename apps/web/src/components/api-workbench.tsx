"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowUp, LoaderCircle, MessageSquare, Monitor, PanelLeftClose, PanelLeftOpen, TriangleAlert } from "lucide-react";
import { getApiWorkspace } from "@/lib/workspace";
import { WorkspaceError } from "@/lib/api-workspace";
import { usePrivateQuery, useWorkspaceAuth } from "@/lib/use-workspace";
import { promptLimit, readDraft, saveDraft, readSessionModel, saveSessionModel } from "@/lib/drafts";
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
import { SessionModelPicker } from "./session-model-picker";
import { useUiPreferences } from "@/lib/ui-preferences";
import { checkMatchesRevision } from "./generation-review";

const rejectedSubmissions = new Set(["INVALID_INPUT", "PROJECT_BUSY", "CLEANUP_PENDING", "STALE_BASE", "IDEMPOTENCY_CONFLICT", "SERVICE_BUSY", "QUOTA_EXCEEDED", "NOT_FOUND", "UNAUTHENTICATED", "MODEL_PROFILE_NOT_FOUND", "MODEL_CONFIG_CHANGED", "MODEL_NOT_VERIFIED", "MODEL_CONFIGURATION_MISSING"]);

function GenerationWorkspace({ projectId }: { projectId: string }) {
  const api = getApiWorkspace();
  const { user } = useWorkspaceAuth();
  const ui = useUiPreferences();
  const ownerId = user!.id;
  const state = useGenerationState(projectId);
  const models = useMemo(() => createModelsApi(api), [api]);
  const modelsLoader = useCallback(() => models.list(), [models]);
  const modelQuery = usePrivateQuery(modelsLoader);
  const [selectedModelId, setSelectedModelId] = useState("");
  const selectedModel = modelQuery.data?.find((model) => model.id === selectedModelId)
    ?? modelQuery.data?.find((model) => model.isDefault) ?? modelQuery.data?.[0];
  // Session-level model override: the catalog model the user picked under this
  // provider credential, persisted for the current browser session. Omitted
  // means "use the credential's default model", which is also frozen per run.
  const [modelOverrideId, setModelOverrideId] = useState<string | null>(() => readSessionModel(ownerId, projectId)?.modelId ?? null);
  const [customModelMode, setCustomModelMode] = useState(false);
  const modelReady = selectedModel?.capabilities.streaming === "verified" && selectedModel.capabilities.tools === "verified";
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
  const [submitError, setSubmitError] = useState("");
  const [stopping, setStopping] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publicationError, setPublicationError] = useState("");
  const [actionError, setActionError] = useState("");
  const [mobileTab, setMobileTab] = useState<"chat" | "result">("chat");
  const [collapsed, setCollapsed] = useState(false);
  const [selectedRevisionId, setSelectedRevisionId] = useState("");
  const project = state.view?.project;
  const run = state.view?.run;
  const clarification = run?.state === "needs_input" ? run.clarification : null;
  const lockedProfile = state.active && run ? modelQuery.data?.find((model) => model.id === run.modelProfileId && model.configVersion === run.modelConfigVersion) : null;
  const revisions = [project?.currentRevision, project?.latestCandidate].filter((revision) => !!revision);
  const revision = revisions.find((item) => item.id === selectedRevisionId) ?? project?.currentRevision ?? project?.latestCandidate ?? null;
  const runRevision = revisions.find((item) => item.id === run?.resultRevisionId);
  const runCheck = project?.latestCheck && runRevision && project.latestCheck.runId === run?.id && checkMatchesRevision(project.latestCheck, runRevision) ? project.latestCheck : null;
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
  const busy = pending || state.active || run?.cleanupState === "pending";
  const tooLong = draft.trim().length > promptLimit;
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => { bottom.current?.scrollIntoView?.({ block: "nearest" }); }, [project?.messages.length, run?.state]);

  function editDraft(value: string) {
    draftRef.current = value; setDraft(value); setDraftStored(saveDraft(ownerId, projectId, value));
  }
  async function send(replay?: RunSubmission) {
    if (sending.current || (!replay && (busy || unknownSubmission || !draft.trim() || tooLong || !modelReady || !selectedModel || !project))) return;
    // The run freezes (profileId, configVersion, modelId). The model override is
    // only serialized when it differs from the credential's default; otherwise
    // the frozen version row already pins the default model.
    const overrideModelId = effectiveModelId && selectedModel && effectiveModelId !== selectedModel.modelId ? effectiveModelId : null;
    const submission: RunSubmission = replay ?? {
      key: crypto.randomUUID(),
      body: { text: draft.trim(), expectedCurrentRevisionId: project!.project.currentRevisionId,
        modelProfileId: selectedModel!.id, modelConfigVersion: selectedModel!.configVersion,
        ...(overrideModelId ? { modelId: overrideModelId } : {}),
        retryOfRunId: null, parentRunId: clarification && run ? run.id : null },
    };
    sending.current = true; setPending(true); setSubmitError("");
    const persisted = savePendingSubmission(ownerId, projectId, submission);
    try {
      const accepted = await state.generation.start(projectId, submission);
      clearPendingSubmission(ownerId, projectId); setUnknownSubmission(null);
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

  const canStop = state.active && !!run && run.state !== "cancel_requested";
  const quotaFull = !!project?.quota && project.quota.dailyAccepted >= project.quota.dailyLimit;
  async function stop() {
    if (!run || stopping) return;
    setStopping(true); setActionError("");
    try { await state.generation.cancel(run.id); await state.refresh(); }
    catch (reason) { setActionError(errorMessage(reason)); }
    finally { setStopping(false); }
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
    if (!revision || restoring) return;
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
    if (!current || publishing || state.active) return;
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
    } catch (reason) { setPublicationError(errorMessage(reason)); }
    finally { setPublishing(false); }
  }

  if (!project && state.error) return <><AppHeader /><main className="standalone-state"><TriangleAlert size={30} /><h1>{ui.text("暂时无法打开这个项目", "This project is temporarily unavailable")}</h1><p role="alert">{state.error}</p><div className="inline-actions"><Button variant="outline" onClick={() => void state.refresh()}>{ui.text("重新加载", "Reload")}</Button><Button asChild><Link href="/projects">{ui.text("返回我的项目", "Back to projects")}</Link></Button></div></main></>;
  if (!project) return <><AppHeader /><div className="page-loader" aria-label={ui.text("正在打开项目", "Opening project")}><LoaderCircle className="spin" size={24} /></div></>;
  return <div className="workbench-page">
    <AppHeader title={project.project.title} saving={state.active} />
    <nav className="mobile-workbench-tabs" aria-label={ui.text("工作区", "Workspace")}><button aria-pressed={mobileTab === "chat"} onClick={() => setMobileTab("chat")}><MessageSquare size={15} />{ui.text("对话", "Chat")}{state.active && <span className="mini-dot" />}</button><button aria-pressed={mobileTab === "result"} onClick={() => setMobileTab("result")}><Monitor size={15} />{ui.text("结果", "Result")}{revision && <span>v{revision.revisionNo}</span>}</button></nav>
    <main className={cn("workbench-layout", `mobile-show-${mobileTab}`, collapsed && "chat-collapsed")}>
      <section className="chat-panel" aria-label={ui.text("与 Pivloom 对话", "Chat with Pivloom")}>
        <div className="chat-panel-heading"><div><span className="chat-heading-icon"><MessageSquare size={15} /></span><strong>{ui.text("构建你的想法", "Build your idea")}</strong><span className="conversation-badge">{ui.text("对话", "Chat")}</span></div><button className="icon-button collapse-button" onClick={() => setCollapsed(true)} aria-label={ui.text("收起对话", "Collapse chat")}><PanelLeftClose size={16} /></button></div>
        <div className="chat-scroll">
          {project.messages.length === 0 ? <div className="chat-welcome"><LoomMark /><h2>{ui.text("想法已经就位", "Your idea starts here")}</h2><p>{ui.text("描述你想实现的功能，用自己的模型开始构建。", "Describe what you want and build it with your model.")}</p></div>
            : project.messages.filter((message) => !(clarification && message.kind === "question" && message.runId === run?.id)).map((message) => message.kind === "user" ? <article className="user-message" key={message.id}><div>{message.content}</div></article>
              : <article className="assistant-message" key={message.id}><div className="assistant-message-heading"><LoomMark /><strong>{message.kind === "question" ? ui.text("协调者", "Coordinator") : "Pivloom"}</strong></div><div className="assistant-message-body"><p className="message-content">{message.content}</p></div></article>)}
          {run && <GenerationActivity run={run} events={state.view!.events} roles={state.view!.roles} />}
          <div ref={bottom} />
        </div>
        <div className="chat-bottom">
          {run && <GenerationOutcome run={run} candidateSaved={project.latestCandidate?.runId === run.id && project.latestCandidate.id === run.resultRevisionId} check={runCheck} />}
          {state.active && <p className={cn("generation-connection", (state.connection === "polling" || state.connection === "unavailable") && "generation-connection-warning")} role="status">{state.connection === "awaiting_snapshot" ? "需求已接收，正在读取任务状态。" : state.connection === "unavailable" ? "任务不存在或无权访问，已停止重连。" : state.connection === "polling" ? "实时连接暂不可用，正在定时读取任务状态。" : state.connection === "connected" ? "已连接实时执行记录" : "正在连接实时执行记录…"}{state.connection === "unavailable" && <button className="generation-inline-retry" onClick={() => void state.refresh()}>重新读取任务</button>}</p>}
          {state.error && <p className="inline-error" role="alert">{state.error}<button className="generation-inline-retry" onClick={() => void state.refresh()}>重新读取</button></p>}
          {actionError && <p className="inline-error" role="alert">{actionError}</p>}
          {!state.active && run && run.error?.retryable && <p className="generation-retry-row" role="status">{run.error.message}<Button variant="outline" size="sm" disabled={pending || !modelReady} onClick={() => void retry()}>以新任务重试</Button></p>}
          {submitError && <p className="inline-error" role="alert">{submitError}</p>}
          {unknownSubmission && <div className="run-notice" role="status"><div><strong>{ui.text("上次提交的结果尚未确认", "Previous submission is not confirmed")}</strong><p>{ui.text("确认会沿用原请求，不会把正在编辑的草稿重复发送。", "Confirming reuses the original request without sending your draft twice.")}</p></div><button disabled={pending} onClick={() => void send(unknownSubmission)}>{ui.text("确认提交结果", "Confirm submission")}</button></div>}
          {!state.active && (modelQuery.error || modelQuery.data && !modelReady) && <p className="generation-model-help" role="status">{modelQuery.error || (selectedModel ? "此配置尚未通过流式和工具调用测试。" : "先连接并测试你要使用的模型。")}{" "}<Link href="/settings/models">前往模型设置</Link></p>}
          <form className={cn("chat-composer", state.active && "composer-running")} onSubmit={(event) => { event.preventDefault(); void send(); }}>
            <label className="sr-only" htmlFor="followup-prompt">{clarification ? ui.text("回答澄清问题", "Answer clarification") : ui.text("应用需求", "App request")}</label>
            <textarea id="followup-prompt" value={draft} onChange={(event) => editDraft(event.target.value)} placeholder={busy ? ui.text("可以先写下一条需求，任务结束后再发送…", "Draft the next request while this run finishes…") : clarification ? ui.text("回答上面的问题，继续原需求…", "Answer the question to continue…") : ui.text("描述你想实现或修改的功能…", "Describe what you want to build or change…")} aria-invalid={tooLong} aria-describedby={[tooLong ? "draft-error" : "", clarification ? "clarification-question" : ""].filter(Boolean).join(" ") || undefined} onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void send(); }
            }} />
            <div className="chat-composer-controls"><span><span className="small-status-dot" />{run?.state === "repairing" ? `检查未通过，正在自动修复（第 ${run.attempt + 1} 轮）` : run?.state === "cancel_requested" || stopping ? "正在停止：等待远端模型与沙箱清理确认" : state.active ? "正在执行，可以继续写草稿" : run?.cleanupState === "pending" ? "正在清理执行资源" : clarification ? "回答后继续原需求" : "准备好你的下一个想法"}{project.quota && <span className="generation-quota">今日额度 {project.quota.dailyAccepted}/{project.quota.dailyLimit}</span>}</span>
              <span className="composer-actions"><SessionModelPicker profiles={modelQuery.data} selectedProfileId={selectedModel?.id} catalog={credentialModels} effectiveModelId={effectiveModelId} lockedLabel={state.active && run ? `${lockedProfile?.name ?? "已保存配置"} · ${run.modelId ?? lockedProfile?.modelId ?? "模型"} · v${run.modelConfigVersion}` : undefined} disabled={pending || state.active} onProfile={(id) => { setSelectedModelId(id); setModelOverrideId(null); setCustomModelMode(false); saveSessionModel(ownerId, projectId, id, null); }} onModel={(id) => { if (!selectedModel) return; setCustomModelMode(false); setModelOverrideId(id); saveSessionModel(ownerId, projectId, selectedModel.id, id); }} onCustom={(id) => { if (!selectedModel) return; setCustomModelMode(true); setModelOverrideId(id); saveSessionModel(ownerId, projectId, selectedModel.id, id); }} onRefresh={modelQuery.refresh} />{canStop && <Button type="button" variant="outline" size="sm" disabled={stopping} onClick={() => void stop()} aria-label={ui.text("停止任务", "Stop run")}>{stopping ? <><LoaderCircle className="spin" size={14} />{ui.text("正在停止", "Stopping")}</> : ui.text("停止", "Stop")}</Button>}<Button type="submit" size="icon" disabled={busy || !!unknownSubmission || !draft.trim() || tooLong || !modelReady} aria-label={clarification ? ui.text("发送回答", "Send answer") : ui.text("发送需求", "Send request")}>{pending ? <LoaderCircle className="spin" size={16} /> : <ArrowUp size={18} />}</Button></span></div>
          </form>
          {quotaFull && <p className="generation-model-help" role="status">今日任务额度已用完（{project.quota!.dailyLimit} 个），请明日再试或联系维护者。</p>}
          {tooLong && <p id="draft-error" className="inline-error" role="alert">需求最多 {promptLimit.toLocaleString()} 个字符。</p>}
          <div className="composer-hint"><span>{draftStored ? ui.text("Enter 发送 · Shift + Enter 换行", "Enter to send · Shift + Enter for a new line") : ui.text("草稿未保存，请保持页面打开", "Draft not saved; keep this page open")}</span><span>{draft.length} / {promptLimit}</span></div>
        </div>
      </section>
      <div className="generation-result-shell">
        {collapsed && <button className="generation-expand-chat icon-button" aria-label={ui.text("展开对话", "Expand chat")} onClick={() => setCollapsed(false)}><PanelLeftOpen size={16} /></button>}
        {project.currentRevision && <div className="publication-bar">
          <span>{publicationQuery.data?.revisionId === project.currentRevision.id
            ? ui.text("当前版本已永久发布", "Current version is published")
            : ui.text("预览会到期，发布后可用独立域名长期访问", "Previews expire; publish for a lasting URL")}</span>
          {publicationQuery.data && <a href={publicationQuery.data.url} target="_blank" rel="noopener noreferrer">{ui.text("访问已发布作品", "Open published app")}</a>}
          {publicationQuery.data?.revisionId !== project.currentRevision.id && <Button size="sm" disabled={publishing || state.active} onClick={() => void publish()}>
            {publishing ? <><LoaderCircle className="spin" size={14} />{ui.text("正在发布…", "Publishing…")}</> : ui.text(publicationQuery.data ? "发布新版本" : "永久发布", publicationQuery.data ? "Publish update" : "Publish app")}
          </Button>}
        </div>}
        {(publicationError || publicationQuery.error) && <p className="inline-error" role="alert">{publicationError || publicationQuery.error}</p>}
        {revisions.length > 1 && <label className="generation-revision-picker">{ui.text("查看版本", "View version")}<select value={revision?.id ?? ""} onChange={(event) => setSelectedRevisionId(event.target.value)}>{revisions.map((item) => <option key={item.id} value={item.id}>v{item.revisionNo} · {item.status === "candidate" ? ui.text("候选", "Candidate") : item.status === "rejected" ? ui.text("未通过候选", "Failed candidate") : ui.text("当前版本", "Current")}</option>)}</select></label>}
        {previewQuery.error && <p className="inline-error" role="alert">{previewQuery.error}</p>}
        <GenerationResult revision={revision} preview={hasSnapshotPreview ? snapshotPreview! : previewQuery.data ?? null} generation={state.generation} active={state.active} latestCheck={project.latestCheck} checking={state.active && run?.phase === "review" && revision?.runId === run.id} restoring={restoring || (previewQuery.data?.state === "restoring" && previewQuery.data.revisionId === revision?.id)} onRestore={state.active ? undefined : () => void restore()} />
      </div>
    </main>
  </div>;
}
export function ApiWorkbench({ projectId }: { projectId: string }) { return <AuthGate><GenerationWorkspace key={projectId} projectId={projectId} /></AuthGate>; }
