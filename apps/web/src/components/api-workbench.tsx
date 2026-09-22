"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { ArrowUp, Code2, FolderOpen, LoaderCircle, MessageSquare, Monitor, TriangleAlert } from "lucide-react";
import { getApiWorkspace } from "@/lib/workspace";
import { usePrivateQuery, useWorkspaceAuth } from "@/lib/use-workspace";
import { promptLimit, readDraft, saveDraft } from "@/lib/drafts";
import { AppHeader } from "./app-header";
import { AuthGate } from "./auth-gate";
import { LoomMark } from "./brand";
import { Button } from "./ui/button";

function EmptyWorkspace({ projectId }: { projectId: string }) {
  const api = getApiWorkspace();
  const { user } = useWorkspaceAuth();
  const loader = useCallback(() => api.getProject(projectId), [api, projectId]);
  const { data, error, refresh } = usePrivateQuery(loader);
  const [draft, setDraft] = useState(() => readDraft(user!.id, projectId));
  const [draftStored, setDraftStored] = useState(true);
  const [tab, setTab] = useState<"preview" | "code">("preview");
  const [mobileTab, setMobileTab] = useState<"chat" | "result">("chat");
  const tooLong = draft.trim().length > promptLimit;
  if (error) return <><AppHeader /><main className="standalone-state"><TriangleAlert size={30} /><h1>暂时无法打开这个项目</h1><p role="alert">{error}</p><div className="inline-actions"><Button variant="outline" onClick={refresh}>重新加载</Button><Button asChild><Link href="/projects">返回我的项目</Link></Button></div></main></>;
  if (!data) return <><AppHeader /><div className="page-loader" aria-label="正在打开项目"><LoaderCircle className="spin" size={24} /></div></>;
  return <div className="workbench-page">
    <AppHeader title={data.project.title} />
    <nav className="mobile-workbench-tabs" aria-label="工作区"><button aria-pressed={mobileTab === "chat"} onClick={() => setMobileTab("chat")}><MessageSquare size={15} />对话</button><button aria-pressed={mobileTab === "result"} onClick={() => setMobileTab("result")}><Monitor size={15} />结果</button></nav>
    <main className={`workbench-layout mobile-show-${mobileTab}`}>
      <section className="chat-panel" aria-label="与 Pivloom 对话">
        <div className="chat-panel-heading"><div><span className="chat-heading-icon"><MessageSquare size={15} /></span><strong>构建你的想法</strong><span className="conversation-badge">对话</span></div></div>
        <div className="chat-scroll"><div className="chat-welcome"><LoomMark /><h2>想法已经就位</h2><p>你的空项目已保存。先准备需求，并连接你要使用的模型。</p><Button asChild variant="outline"><Link href="/settings/models">连接模型</Link></Button></div></div>
        <div className="chat-bottom">
          <div className="run-notice" role="status"><div><strong>生成能力正在接入</strong><p>目前可以保存和打开项目。接入完成后，这里将开始真实构建。</p></div></div>
          <form className="chat-composer" onSubmit={(event) => event.preventDefault()}>
            <label className="sr-only" htmlFor="followup-prompt">描述应用需求</label>
            <textarea id="followup-prompt" value={draft} onChange={(event) => { setDraft(event.target.value); setDraftStored(saveDraft(user!.id, projectId, event.target.value)); }} placeholder="先写下你想实现的功能…" aria-invalid={tooLong} aria-describedby={tooLong ? "draft-error" : undefined} />
            <div className="chat-composer-controls"><span><span className="small-status-dot" />尚未发送</span><Button type="submit" size="icon" disabled aria-label="发送需求（生成能力接入中）"><ArrowUp size={18} /></Button></div>
          </form>
          {tooLong && <p id="draft-error" className="inline-error" role="alert">需求最多 {promptLimit.toLocaleString()} 个字符。</p>}
          <div className="composer-hint"><span>{draftStored ? "草稿保存在当前浏览器会话" : "浏览器未允许保存草稿，请勿刷新"}</span><span>{draft.length} / {promptLimit}</span></div>
        </div>
      </section>
      <section className="result-panel" aria-label="应用结果">
        <div className="result-toolbar"><div className="view-tabs" role="tablist" aria-label="结果视图">
          <button role="tab" id="preview-tab" aria-selected={tab === "preview"} aria-controls="empty-result" tabIndex={tab === "preview" ? 0 : -1} onClick={() => setTab("preview")} onKeyDown={(event) => { if (event.key === "ArrowRight") { setTab("code"); document.getElementById("code-tab")?.focus(); } }}><Monitor size={14} />预览</button>
          <button role="tab" id="code-tab" aria-selected={tab === "code"} aria-controls="empty-result" tabIndex={tab === "code" ? 0 : -1} onClick={() => setTab("code")} onKeyDown={(event) => { if (event.key === "ArrowLeft") { setTab("preview"); document.getElementById("preview-tab")?.focus(); } }}><Code2 size={15} />代码</button>
        </div></div>
        <div id="empty-result" className="api-empty-result" role="tabpanel" aria-labelledby={tab === "preview" ? "preview-tab" : "code-tab"}><FolderOpen size={30} /><h2>{tab === "preview" ? "你的应用，将从这里开始" : "还没有生成源码"}</h2><p>{tab === "preview" ? "真实构建完成后，预览会出现在这里。" : "生成版本保存后，可以查看对应的源文件。"}</p></div>
      </section>
    </main>
  </div>;
}
export function ApiWorkbench({ projectId }: { projectId: string }) { return <AuthGate><EmptyWorkspace key={projectId} projectId={projectId} /></AuthGate>; }
