"use client";
/* Private, authenticated Blob URLs cannot go through the Next image optimizer. */
/* eslint-disable @next/next/no-img-element */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowRight, ArrowUp, ArrowUpRight, ChevronRight, FolderOpen, Layers3, LoaderCircle, Plus } from "lucide-react";
import type { ProjectSummary } from "@pivloom/contracts";
import { AppHeader } from "./app-header";
import { AuthGate } from "./auth-gate";
import { LoomMark } from "./brand";
import { Button } from "./ui/button";
import { getApiWorkspace, isDemoMode } from "@/lib/workspace";
import { usePrivateQuery, useWorkspaceAuth } from "@/lib/use-workspace";
import { createGenerationApi, type GenerationApi } from "@/lib/generation-api";
import { errorMessage, relativeTime } from "@/lib/utils";
import { promptLimit, readDraft, saveDraft, saveSessionModel } from "@/lib/drafts";
import { createModelsApi } from "@/lib/models-api";
import { featuredTemplates, findTemplate } from "@/lib/templates";
import { useUiPreferences } from "@/lib/ui-preferences";

const DemoProjects = dynamic(() => import("./demo-projects-page").then((module) => module.ProjectsPage));
function ProjectCard({ project, generation }: { project: ProjectSummary; generation: GenerationApi }) {
  const ui = useUiPreferences();
  const loadCheck = useCallback(() => project.currentRevisionId ? generation.getCheck(project.currentRevisionId) : Promise.resolve(null), [generation, project.currentRevisionId]);
  const { data: check } = usePrivateQuery(loadCheck);
  const artifact = check?.verdict === "passed" ? check.artifacts.at(-1) : undefined;
  const [image, setImage] = useState<{ key: string; url: string } | null>(null);
  useEffect(() => {
    if (!artifact || !check) return;
    const controller = new AbortController();
    let url: string | undefined;
    void generation.getArtifact(check.id, artifact, controller.signal).then((blob) => {
      if (controller.signal.aborted) return;
      url = URL.createObjectURL(blob);
      setImage({ key: `${check.id}:${artifact.id}`, url });
    }).catch(() => { /* A missing or expired artifact uses the explicit fallback. */ });
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [artifact, check, generation]);
  const thumbnail = image?.key === `${check?.id}:${artifact?.id}` ? image.url : null;
  // The card reports the project's real task state: a task waiting for capacity
  // must not read as an idle saved version, and the position comes from the
  // scheduler rather than an estimate. A blocked task reports no position.
  const activity = project.activeRunState === "queued"
    ? { label: project.activeRunPosition ? ui.text(`排队中 · 第 ${project.activeRunPosition} 位`, `Queued · position ${project.activeRunPosition}`) : ui.text("排队中", "Queued"), tone: "queued" }
    : project.activeRunState === "cancel_requested"
      ? { label: ui.text("正在停止", "Stopping"), tone: "stopping" }
      : project.activeRunState ? { label: ui.text("执行中", "Running"), tone: "running" } : null;
  return <Link className="project-card project-card-api" href={`/projects/${project.id}`}>
    <div className={`project-thumbnail api-project-thumbnail ${thumbnail ? "has-screenshot" : "no-screenshot"}`}>
      {thumbnail ? <img className="project-screenshot" src={thumbnail} alt={ui.text(`${project.title} 的已保存应用截图`, `Saved app screenshot for ${project.title}`)} />
        : <div className="project-thumbnail-placeholder"><div className="thumbnail-skeleton-top"><i /><i /><i /><span /></div><div className="thumbnail-skeleton-content"><b /><b /><div><i /><i /><i /></div></div><span>{project.currentRevisionId ? ui.text("暂无截图", "No screenshot available") : ui.text("生成后显示预览", "Preview appears after generation")}</span></div>}
      <span className="project-thumbnail-caption">{thumbnail ? ui.text("应用截图", "App screenshot") : project.currentRevisionId ? ui.text("已保存版本", "Saved version") : ui.text("空项目", "Empty project")}</span><span className="project-open"><ArrowUpRight size={18} /></span>
    </div>
    <div className="project-card-body">
      <div className="project-name-row"><h3>{project.title}</h3><ChevronRight size={15} /></div>
      <p>{project.currentRevisionId ? ui.text("继续完善你的应用", "Keep building your app") : ui.text("项目已保存，随时开始创作", "Saved and ready whenever you are")}</p>
      <div className="project-card-meta"><span className={`card-state${activity ? ` card-state-${activity.tone}` : ""}`} data-testid={activity ? `project-activity-${activity.tone}` : undefined}><span className="mini-dot" />{activity ? activity.label : project.currentRevisionId ? ui.text("已有版本", "Version ready") : ui.text("空项目", "Empty project")}</span><time dateTime={project.updatedAt}>{relativeTime(project.updatedAt)}</time></div>
    </div>
  </Link>;
}

function ApiProjectsContent({ initialSurface }: { initialSurface: "new" | "projects" }) {
  const router = useRouter();
  const api = getApiWorkspace();
  const generation = useMemo(() => createGenerationApi(api), [api]);
  const modelsApi = useMemo(() => createModelsApi(api), [api]);
  const { user } = useWorkspaceAuth();
  const ui = useUiPreferences();
  const [surface, setSurface] = useState<"new" | "projects">(initialSurface);
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [prompt, setPrompt] = useState(() => readDraft(user!.id, "new"));
  const [busy, setBusy] = useState(false);
  const creating = useRef(false);
  const [error, setError] = useState("");
  const [pages, setPages] = useState<ProjectSummary[]>([]);
  const [next, setNext] = useState<string | null | undefined>();
  const [loadingMore, setLoadingMore] = useState(false);
  const loader = useCallback(() => api.listProjects(), [api]);
  const modelLoader = useCallback(() => modelsApi.list(), [modelsApi]);
  const { data, error: loadError, refresh } = usePrivateQuery(loader);
  const modelQuery = usePrivateQuery(modelLoader);
  const selectedProfile = modelQuery.data?.find((profile) => profile.id === selectedProfileId)
    ?? modelQuery.data?.find((profile) => profile.isDefault) ?? modelQuery.data?.[0];
  const modelReady = selectedProfile?.capabilities.streaming === "verified" && selectedProfile.capabilities.tools === "verified";
  const projects = data ? [...data.projects, ...pages.filter((project) => !data.projects.some((item) => item.id === project.id))] : undefined;
  const cursor = next === undefined ? data?.nextCursor : next;
  const tooLong = prompt.trim().length > promptLimit;
  function showSurface(next: "new" | "projects") {
    setSurface(next);
    router.push(next === "projects" ? "/projects?view=list" : "/projects", { scroll: false });
  }
  function updatePrompt(value: string) { setPrompt(value); saveDraft(user!.id, "new", value); }
  useEffect(() => {
    const onPopState = () => setSurface(new URLSearchParams(window.location.search).get("view") === "list" ? "projects" : "new");
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  useEffect(() => {
    const slug = new URLSearchParams(window.location.search).get("template");
    const template = slug ? findTemplate(slug) : undefined;
    if (!template) return;
    queueMicrotask(() => {
      updatePrompt(ui.locale === "en" ? template.promptEn : template.prompt);
      window.history.replaceState(window.history.state, "", "/projects");
    });
  // Read the arriving template only once; a later locale switch must not overwrite edits.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);
  async function create() {
    if (creating.current || !prompt.trim() || tooLong) return;
    if (!modelReady || !selectedProfile) { setError("请先连接并测试支持流式输出和工具调用的模型，再开始生成。"); return; }
    if (!saveDraft(user!.id, "new", prompt.trim())) { setError("浏览器暂时无法保存需求草稿。请允许此站点使用会话存储后重试，避免创建空项目。"); return; }
    creating.current = true; setBusy(true); setError("");
    try {
      const project = await api.createProject(prompt.trim().slice(0, 120));
      saveDraft(user!.id, project.id, prompt.trim());
      if (selectedProfile) saveSessionModel(user!.id, project.id, selectedProfile.id, selectedProfile.modelId);
      saveDraft(user!.id, "new", "");
      router.push(`/projects/${project.id}?start=1`);
    } catch (error) { setError(errorMessage(error)); creating.current = false; setBusy(false); }
  }
  async function more() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true); setError("");
    try {
      const result = await api.listProjects(cursor);
      setPages((items) => [...items, ...result.projects.filter((project) => !items.some((item) => item.id === project.id))]);
      setNext(result.nextCursor);
    } catch (error) { setError(errorMessage(error)); }
    finally { setLoadingMore(false); }
  }
  return <div className="projects-page a-projects-page">
    <AppHeader><button className="a-header-view" onClick={() => showSurface(surface === "new" ? "projects" : "new")}>{surface === "new" ? ui.text("我的项目", "My projects") : ui.text("开始创作", "Start creating")}<ArrowRight size={14} /></button></AppHeader>
    {surface === "new" ? <main className="a-start" aria-labelledby="home-title">
      <div className="a-start-orbit orbit-one" aria-hidden="true" /><div className="a-start-orbit orbit-two" aria-hidden="true" />
      <div className="a-start-inner">
        <div className="a-start-mark"><LoomMark /><span>{ui.text("从想法到作品", "From idea to app")}</span></div>
        <h1 id="home-title">{ui.text("你想创造什么", "What will you create")}<span>？</span></h1>
        <p>{ui.text("一句话开始。工具、网站或小游戏，都可以慢慢长成你想要的样子。", "Start with a sentence. Let a tool, website or game grow from there.")}</p>
        <form className="a-start-composer" onSubmit={(event) => { event.preventDefault(); void create(); }}>
          <label className="sr-only" htmlFor="new-project-prompt">{ui.text("新项目需求", "New project request")}</label>
          <textarea id="new-project-prompt" value={prompt} onChange={(event) => updatePrompt(event.target.value)} placeholder={ui.text("描述你想做的作品，越具体越好…", "Describe what you want to make…")} disabled={busy} aria-invalid={tooLong} aria-describedby={tooLong ? "prompt-error" : undefined}
            onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void create(); } }} />
          <div className="a-start-composer-bottom">
            {modelQuery.data?.length ? <label className="a-start-model"><Layers3 size={14} /><span className="sr-only">{ui.text("初始模型", "Initial model")}</span><select value={selectedProfile?.id ?? ""} onChange={(event) => setSelectedProfileId(event.target.value)}>{modelQuery.data.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · {profile.modelId}</option>)}</select></label>
              : <Link className="a-start-model" href="/settings/models"><Layers3 size={14} />{ui.text("连接模型", "Connect a model")}</Link>}
            <span>{ui.text("Enter 开始 · Shift + Enter 换行", "Enter to start · Shift + Enter for a new line")}</span>
            <Button type="submit" size="icon" disabled={!prompt.trim() || tooLong || busy || !modelReady} aria-label={ui.text("创建并开始生成", "Create and start generating")}>{busy ? <LoaderCircle className="spin" size={18} /> : <ArrowUp size={19} />}</Button>
          </div>
        </form>
        {tooLong && <p id="prompt-error" className="inline-error" role="alert">需求最多 {promptLimit.toLocaleString()} 个字符，请缩短后再创建。</p>}
        {error && <p className="inline-error" role="alert">{error}</p>}
        {modelQuery.error && <p className="a-start-model-error" role="status">{modelQuery.error} <Link href="/settings/models">{ui.text("查看模型配置", "Model settings")}</Link></p>}
        {!modelQuery.error && modelQuery.data && !modelReady && <p className="a-start-model-error" role="status">当前模型尚未通过流式输出和工具调用测试。<Link href="/settings/models">去测试模型</Link></p>}
        <div className="a-start-suggestions"><div><span>{ui.text("试试一个想法", "Try an idea")}</span><Link href="/templates">{ui.text("浏览全部模板", "Browse templates")}<ArrowRight size={13} /></Link></div><div>{featuredTemplates.map((template) => <button key={template.slug} onClick={() => updatePrompt(ui.locale === "en" ? template.promptEn : template.prompt)}>{ui.text(template.title, template.titleEn)}<ArrowRight size={13} /></button>)}</div></div>
        <button className="a-start-project-link" onClick={() => showSurface("projects")}>{ui.text("查看已有项目", "View existing projects")}<ArrowRight size={14} /></button>
      </div>
    </main> : <main className="a-project-list">
      <div className="a-project-list-heading"><div><span className="section-eyebrow">YOUR WORKSPACE</span><h1>{ui.text("我的项目", "My projects")}</h1><p>{ui.text("把想法变成作品，再慢慢完善。", "Make an idea real, then keep improving it.")}</p></div><Button onClick={() => { updatePrompt(""); showSurface("new"); }}><Plus size={17} />{ui.text("新建项目", "New project")}</Button></div>
      <div className="a-project-list-filter"><strong>{ui.text("全部项目", "All projects")} <span>{projects?.length ?? "—"}</span></strong><span>{ui.text("最近编辑", "Recently edited")}</span></div>
      {loadError ? <div className="empty-projects" role="alert"><p>{loadError}</p><Button variant="outline" onClick={refresh}>重新加载</Button></div>
        : !projects ? <div className="project-grid" aria-label="正在加载项目">{[0, 1, 2].map((i) => <div className="project-skeleton" key={i} />)}</div>
        : projects.length === 0 ? <div className="empty-projects"><FolderOpen size={32} /><h2>{ui.text("还没有项目", "No projects yet")}</h2><p>{ui.text("从一个想法开始，作品会保存在这里。", "Start with an idea. Your work will appear here.")}</p><Button onClick={() => showSurface("new")}>{ui.text("开始创作", "Start creating")}</Button></div>
        : <div className="project-grid">{projects.map((project) => <ProjectCard key={project.id} project={project} generation={generation} />)}</div>}
      {cursor && <div className="load-more-projects"><Button variant="outline" disabled={loadingMore} onClick={() => void more()}>{loadingMore ? "正在加载" : "加载更多项目"}</Button></div>}
      <div className="a-project-list-bottom">{ui.text("从空白开始，或使用一个模板。", "Start blank or use a template.")}<Link href="/templates">{ui.text("探索模板", "Explore templates")}<ArrowRight size={14} /></Link></div>
    </main>}
  </div>;
}
export function ProjectsPage({ initialSurface = "new" }: { initialSurface?: "new" | "projects" }) { return isDemoMode ? <DemoProjects initialSurface={initialSurface} /> : <AuthGate><ApiProjectsContent initialSurface={initialSurface} /></AuthGate>; }
