"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowUp, LoaderCircle, MessageSquare, Monitor, PanelLeftClose, PanelLeftOpen, RefreshCw, TriangleAlert } from "lucide-react";
import { getApiWorkspace } from "@/lib/workspace";
import { WorkspaceError } from "@/lib/api-workspace";
import { usePrivateQuery, useWorkspaceAuth } from "@/lib/use-workspace";
import { promptLimit, readDraft, saveDraft } from "@/lib/drafts";
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

const rejectedSubmissions = new Set(["INVALID_INPUT", "PROJECT_BUSY", "CLEANUP_PENDING", "STALE_BASE", "IDEMPOTENCY_CONFLICT", "SERVICE_BUSY", "QUOTA_EXCEEDED", "NOT_FOUND", "UNAUTHENTICATED", "MODEL_PROFILE_NOT_FOUND", "MODEL_CONFIG_CHANGED", "MODEL_NOT_VERIFIED", "MODEL_CONFIGURATION_MISSING"]);

function GenerationWorkspace({ projectId }: { projectId: string }) {
  const api = getApiWorkspace();
  const { user } = useWorkspaceAuth();
  const ownerId = user!.id;
  const state = useGenerationState(projectId);
  const models = useMemo(() => createModelsApi(api), [api]);
  const modelsLoader = useCallback(() => models.list(), [models]);
  const modelQuery = usePrivateQuery(modelsLoader);
  const [selectedModelId, setSelectedModelId] = useState("");
  const selectedModel = modelQuery.data?.find((model) => model.id === selectedModelId)
    ?? modelQuery.data?.find((model) => model.isDefault) ?? modelQuery.data?.[0];
  const modelReady = selectedModel?.capabilities.streaming === "verified" && selectedModel.capabilities.tools === "verified";
  const [draft, setDraft] = useState(() => readDraft(ownerId, projectId));
  const draftRef = useRef(draft);
  const [draftStored, setDraftStored] = useState(true);
  const [pending, setPending] = useState(false);
  const sending = useRef(false);
  const [unknownSubmission, setUnknownSubmission] = useState<RunSubmission | null>(() => readPendingSubmission(ownerId, projectId));
  const [submitError, setSubmitError] = useState("");
  const [mobileTab, setMobileTab] = useState<"chat" | "result">("chat");
  const [collapsed, setCollapsed] = useState(false);
  const [selectedRevisionId, setSelectedRevisionId] = useState("");
  const project = state.view?.project;
  const run = state.view?.run;
  const lockedProfile = state.active && run ? modelQuery.data?.find((model) => model.id === run.modelProfileId && model.configVersion === run.modelConfigVersion) : null;
  const revisions = [project?.currentRevision, project?.latestCandidate].filter((revision) => !!revision);
  const revision = revisions.find((item) => item.id === selectedRevisionId) ?? project?.currentRevision ?? project?.latestCandidate ?? null;
  const snapshotPreview = project?.preview;
  const revisionId = revision?.id;
  const hasSnapshotPreview = !!snapshotPreview && snapshotPreview.revisionId === revisionId && snapshotPreview.sourceHash === revision?.sourceHash;
  const previewLoader = useCallback(async () => {
    if (!revisionId || hasSnapshotPreview) return null;
    return state.generation.getPreview(projectId, revisionId);
  }, [projectId, revisionId, hasSnapshotPreview, state.generation]);
  const previewQuery = usePrivateQuery(previewLoader);
  const busy = pending || state.active || run?.cleanupState === "pending";
  const tooLong = draft.trim().length > promptLimit;
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => { bottom.current?.scrollIntoView?.({ block: "nearest" }); }, [project?.messages.length, run?.state]);

  function editDraft(value: string) {
    draftRef.current = value; setDraft(value); setDraftStored(saveDraft(ownerId, projectId, value));
  }
  async function send(replay?: RunSubmission) {
    if (sending.current || (!replay && (busy || unknownSubmission || !draft.trim() || tooLong || !modelReady || !selectedModel || !project))) return;
    const submission: RunSubmission = replay ?? {
      key: crypto.randomUUID(),
      body: { text: draft.trim(), expectedCurrentRevisionId: project!.project.currentRevisionId,
        modelProfileId: selectedModel!.id, modelConfigVersion: selectedModel!.configVersion, retryOfRunId: null, parentRunId: null },
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

  if (!project && state.error) return <><AppHeader /><main className="standalone-state"><TriangleAlert size={30} /><h1>暂时无法打开这个项目</h1><p role="alert">{state.error}</p><div className="inline-actions"><Button variant="outline" onClick={() => void state.refresh()}>重新加载</Button><Button asChild><Link href="/projects">返回我的项目</Link></Button></div></main></>;
  if (!project) return <><AppHeader /><div className="page-loader" aria-label="正在打开项目"><LoaderCircle className="spin" size={24} /></div></>;
  return <div className="workbench-page">
    <AppHeader title={project.project.title} saving={state.active} />
    <nav className="mobile-workbench-tabs" aria-label="工作区"><button aria-pressed={mobileTab === "chat"} onClick={() => setMobileTab("chat")}><MessageSquare size={15} />对话{state.active && <span className="mini-dot" />}</button><button aria-pressed={mobileTab === "result"} onClick={() => setMobileTab("result")}><Monitor size={15} />结果{revision && <span>v{revision.revisionNo}</span>}</button></nav>
    <main className={cn("workbench-layout", `mobile-show-${mobileTab}`, collapsed && "chat-collapsed")}>
      <section className="chat-panel" aria-label="与 Pivloom 对话">
        <div className="chat-panel-heading"><div><span className="chat-heading-icon"><MessageSquare size={15} /></span><strong>构建你的想法</strong><span className="conversation-badge">对话</span></div><button className="icon-button collapse-button" onClick={() => setCollapsed(true)} aria-label="收起对话"><PanelLeftClose size={16} /></button></div>
        <div className="chat-scroll">
          {project.messages.length === 0 ? <div className="chat-welcome"><LoomMark /><h2>想法已经就位</h2><p>描述你想实现的功能，用自己的模型开始构建。</p></div>
            : project.messages.map((message) => message.kind === "user" ? <article className="user-message" key={message.id}><div>{message.content}</div></article>
              : <article className="assistant-message" key={message.id}><div className="assistant-message-heading"><LoomMark /><strong>Pivloom</strong></div><div className="assistant-message-body"><p className="message-content">{message.content}</p></div></article>)}
          {run && <GenerationActivity run={run} events={state.view!.events} />}
          <div ref={bottom} />
        </div>
        <div className="chat-bottom">
          {run && <GenerationOutcome run={run} candidateSaved={project.latestCandidate?.runId === run.id && project.latestCandidate.id === run.resultRevisionId} />}
          {state.active && <p className={cn("generation-connection", (state.connection === "polling" || state.connection === "unavailable") && "generation-connection-warning")} role="status">{state.connection === "awaiting_snapshot" ? "需求已接收，正在读取任务状态。" : state.connection === "unavailable" ? "任务不存在或无权访问，已停止重连。" : state.connection === "polling" ? "实时连接暂不可用，正在定时读取任务状态。" : state.connection === "connected" ? "已连接实时执行记录" : "正在连接实时执行记录…"}{state.connection === "unavailable" && <button className="generation-inline-retry" onClick={() => void state.refresh()}>重新读取任务</button>}</p>}
          {state.error && <p className="inline-error" role="alert">{state.error}<button className="generation-inline-retry" onClick={() => void state.refresh()}>重新读取</button></p>}
          {submitError && <p className="inline-error" role="alert">{submitError}</p>}
          {unknownSubmission && <div className="run-notice" role="status"><div><strong>上次提交的结果尚未确认</strong><p>确认会沿用原请求，不会把正在编辑的草稿重复发送。</p></div><button disabled={pending} onClick={() => void send(unknownSubmission)}>确认提交结果</button></div>}
          <div className="generation-model-field"><label htmlFor="generation-model">使用模型</label><div>
            <select id="generation-model" value={state.active && run ? `run:${run.id}` : selectedModel?.id ?? ""} disabled={pending || state.active || !modelQuery.data?.length} onChange={(event) => setSelectedModelId(event.target.value)}>
              {state.active && run && <option value={`run:${run.id}`}>{lockedProfile ? `${lockedProfile.name} · ${lockedProfile.modelId}` : "任务使用的已保存配置"} · v{run.modelConfigVersion}（本次已锁定）</option>}
              {!modelQuery.data?.length && !state.active && <option value="">{modelQuery.data ? "尚未配置模型" : "正在读取模型…"}</option>}
              {modelQuery.data?.map((model) => <option key={model.id} value={model.id}>{model.name} · {model.modelId} · v{model.configVersion}{model.isDefault ? "（默认）" : ""}</option>)}
            </select><button className="icon-button" aria-label="刷新模型配置" disabled={pending || state.active} onClick={modelQuery.refresh}><RefreshCw size={14} /></button>
          </div></div>
          {!state.active && (modelQuery.error || modelQuery.data && !modelReady) && <p className="generation-model-help" role="status">{modelQuery.error || (selectedModel ? "此配置尚未通过流式和工具调用测试。" : "先连接并测试你要使用的模型。")}{" "}<Link href="/settings/models">前往模型设置</Link></p>}
          <form className={cn("chat-composer", state.active && "composer-running")} onSubmit={(event) => { event.preventDefault(); void send(); }}>
            <label className="sr-only" htmlFor="followup-prompt">应用需求</label>
            <textarea id="followup-prompt" value={draft} onChange={(event) => editDraft(event.target.value)} placeholder={busy ? "可以先写下一条需求，任务结束后再发送…" : "描述你想实现或修改的功能…"} aria-invalid={tooLong} aria-describedby={tooLong ? "draft-error" : undefined} onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void send(); }
            }} />
            <div className="chat-composer-controls"><span><span className="small-status-dot" />{state.active ? "正在执行，可以继续写草稿" : run?.cleanupState === "pending" ? "正在清理执行资源" : "准备好你的下一个想法"}</span><Button type="submit" size="icon" disabled={busy || !!unknownSubmission || !draft.trim() || tooLong || !modelReady} aria-label="发送需求">{pending ? <LoaderCircle className="spin" size={16} /> : <ArrowUp size={18} />}</Button></div>
          </form>
          {tooLong && <p id="draft-error" className="inline-error" role="alert">需求最多 {promptLimit.toLocaleString()} 个字符。</p>}
          <div className="composer-hint"><span>{draftStored ? "Enter 发送 · Shift + Enter 换行" : "草稿未保存，请保持页面打开"}</span><span>{draft.length} / {promptLimit}</span></div>
        </div>
      </section>
      <div className="generation-result-shell">
        {collapsed && <button className="generation-expand-chat icon-button" aria-label="展开对话" onClick={() => setCollapsed(false)}><PanelLeftOpen size={16} /></button>}
        {revisions.length > 1 && <label className="generation-revision-picker">查看版本<select value={revision?.id ?? ""} onChange={(event) => setSelectedRevisionId(event.target.value)}>{revisions.map((item) => <option key={item.id} value={item.id}>v{item.revisionNo} · {item.status === "candidate" ? "候选，尚未检查" : "当前版本"}</option>)}</select></label>}
        {previewQuery.error && <p className="inline-error" role="alert">{previewQuery.error}</p>}
        <GenerationResult revision={revision} preview={hasSnapshotPreview ? snapshotPreview! : previewQuery.data ?? null} generation={state.generation} active={state.active} />
      </div>
    </main>
  </div>;
}
export function ApiWorkbench({ projectId }: { projectId: string }) { return <AuthGate><GenerationWorkspace key={projectId} projectId={projectId} /></AuthGate>; }
