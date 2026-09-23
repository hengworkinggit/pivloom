"use client";
/* Private, authenticated Blob URLs cannot go through the Next image optimizer. */
/* eslint-disable @next/next/no-img-element */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowRight, ArrowUpRight, ChevronRight, FolderOpen, Layers3, LoaderCircle } from "lucide-react";
import type { ProjectSummary } from "@pivloom/contracts";
import { AppHeader } from "./app-header";
import { AuthGate } from "./auth-gate";
import { Button } from "./ui/button";
import { getApiWorkspace, isDemoMode } from "@/lib/workspace";
import { usePrivateQuery, useWorkspaceAuth } from "@/lib/use-workspace";
import { createGenerationApi, type GenerationApi } from "@/lib/generation-api";
import { errorMessage, relativeTime } from "@/lib/utils";
import { promptLimit, readDraft, saveDraft } from "@/lib/drafts";
import { featuredTemplates, findTemplate } from "@/lib/templates";
import { useUiPreferences } from "@/lib/ui-preferences";
import { TemplateArtwork } from "./template-gallery";

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
  return <Link className="project-card project-card-api" href={`/projects/${project.id}`}>
    <div className={`project-thumbnail api-project-thumbnail ${thumbnail ? "has-screenshot" : "no-screenshot"}`}>
      {thumbnail ? <img className="project-screenshot" src={thumbnail} alt={ui.text(`${project.title} 的已保存应用截图`, `Saved app screenshot for ${project.title}`)} />
        : <div className="project-thumbnail-placeholder"><div className="thumbnail-skeleton-top"><i /><i /><i /><span /></div><div className="thumbnail-skeleton-content"><b /><b /><div><i /><i /><i /></div></div><span>{project.currentRevisionId ? ui.text("暂无截图", "No screenshot available") : ui.text("生成后显示预览", "Preview appears after generation")}</span></div>}
      <span className="project-thumbnail-caption">{thumbnail ? ui.text("应用截图", "App screenshot") : project.currentRevisionId ? ui.text("已保存版本", "Saved version") : ui.text("空项目", "Empty project")}</span><span className="project-open"><ArrowUpRight size={18} /></span>
    </div>
    <div className="project-card-body">
      <div className="project-name-row"><h3>{project.title}</h3><ChevronRight size={15} /></div>
      <p>{project.currentRevisionId ? ui.text("继续完善你的应用", "Keep building your app") : ui.text("项目已保存，随时开始创作", "Saved and ready whenever you are")}</p>
      <div className="project-card-meta"><span className="card-state"><span className="mini-dot" />{project.currentRevisionId ? ui.text("已有版本", "Version ready") : ui.text("空项目", "Empty project")}</span><time dateTime={project.updatedAt}>{relativeTime(project.updatedAt)}</time></div>
    </div>
  </Link>;
}

function ApiProjectsContent() {
  const router = useRouter();
  const api = getApiWorkspace();
  const generation = useMemo(() => createGenerationApi(api), [api]);
  const { user } = useWorkspaceAuth();
  const ui = useUiPreferences();
  const [prompt, setPrompt] = useState(() => readDraft(user!.id, "new"));
  const [busy, setBusy] = useState(false);
  const creating = useRef(false);
  const [error, setError] = useState("");
  const [pages, setPages] = useState<ProjectSummary[]>([]);
  const [next, setNext] = useState<string | null | undefined>();
  const [loadingMore, setLoadingMore] = useState(false);
  const loader = useCallback(() => api.listProjects(), [api]);
  const { data, error: loadError, refresh } = usePrivateQuery(loader);
  const projects = data ? [...data.projects, ...pages.filter((project) => !data.projects.some((item) => item.id === project.id))] : undefined;
  const cursor = next === undefined ? data?.nextCursor : next;
  const tooLong = prompt.trim().length > promptLimit;
  function updatePrompt(value: string) { setPrompt(value); saveDraft(user!.id, "new", value); }
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
    creating.current = true; setBusy(true); setError("");
    try {
      const project = await api.createProject(prompt.trim().slice(0, 120));
      saveDraft(user!.id, project.id, prompt.trim());
      saveDraft(user!.id, "new", "");
      router.push(`/projects/${project.id}`);
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
  return <div className="projects-page">
    <AppHeader />
    <main className="home-main">
      <section className="home-hero" aria-labelledby="home-title">
        <div className="hero-eyebrow"><span className="tiny-weave">✳</span> {ui.text("一个想法，无限可能", "One idea, endless possibilities")}</div>
        <h1 id="home-title">{ui.text("把想法，", "Turn ideas ")}<span>{ui.text("织成应用。", "into apps.")}</span></h1>
        <p className="hero-subtitle">{ui.text("从一句描述开始，让你的下一个想法有迹可循。", "Describe what you want to build and give it a home.")}</p>
        <form className="home-composer" onSubmit={(event) => { event.preventDefault(); void create(); }}>
          <label className="sr-only" htmlFor="new-project-prompt">{ui.text("描述你的应用想法", "Describe your app idea")}</label>
          <textarea id="new-project-prompt" value={prompt} onChange={(event) => updatePrompt(event.target.value)} placeholder={ui.text("你想做一个什么样的应用？", "What would you like to build?")} disabled={busy} aria-invalid={tooLong} aria-describedby={tooLong ? "prompt-error" : undefined}
            onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void create(); } }} />
          <div className="home-composer-footer"><span><Layers3 size={14} /><span>{ui.text("先保存想法，进入你的项目", "Save your idea and open the project")}</span></span><Button type="submit" disabled={!prompt.trim() || tooLong || busy}>{busy && <LoaderCircle className="spin" size={16} />}{busy ? ui.text("正在创建", "Creating") : ui.text("创建项目", "Create project")}<ArrowRight size={16} /></Button></div>
        </form>
        {tooLong && <p id="prompt-error" className="inline-error" role="alert">需求最多 {promptLimit.toLocaleString()} 个字符，请缩短后再创建。</p>}
        {error && <p className="inline-error" role="alert">{error}</p>}
        <div className="featured-templates-heading"><div><span className="section-eyebrow">START WITH A TEMPLATE</span><h2>{ui.text("先看示例，再开始创作", "Explore first. Then create.")}</h2></div><Link href="/templates">{ui.text("浏览全部模板", "Browse all templates")}<ArrowRight size={15} /></Link></div>
        <div className="featured-template-grid">{featuredTemplates.map((template) => <Link className="featured-template" href={`/templates/${template.slug}`} key={template.slug}><TemplateArtwork template={template} /><span>{ui.text(template.title, template.titleEn)}<ArrowUpRight size={14} /></span></Link>)}</div>
      </section>
      <section className="projects-section" aria-labelledby="projects-title">
        <div className="section-heading"><div><div className="section-eyebrow">YOUR WORKSPACE</div><h2 id="projects-title">{ui.text("我的项目", "My projects")} <span className="project-count">{projects?.length ?? "—"}</span></h2><p>{ui.text("每一个想法，都值得接着往下做。", "Every idea deserves a next step.")}</p></div></div>
        {loadError ? <div className="empty-projects" role="alert"><p>{loadError}</p><Button variant="outline" onClick={refresh}>重新加载</Button></div>
          : !projects ? <div className="project-grid" aria-label="正在加载项目">{[0, 1, 2].map((i) => <div className="project-skeleton" key={i} />)}</div>
          : projects.length === 0 ? <div className="empty-projects"><FolderOpen size={32} /><h3>{ui.text("你的第一个想法，从这里开始", "Start your first project")}</h3><p>{ui.text("描述一个想法，或先浏览模板。你的作品会保存在这里。", "Describe an idea or explore a template. Your work will live here.")}</p><Button variant="outline" asChild><Link href="/settings/models">{ui.text("先连接模型", "Connect a model")}<ArrowRight size={15} /></Link></Button></div>
          : <div className="project-grid">{projects.map((project) => <ProjectCard key={project.id} project={project} generation={generation} />)}</div>}
        {cursor && <div className="load-more-projects"><Button variant="outline" disabled={loadingMore} onClick={() => void more()}>{loadingMore ? "正在加载" : "加载更多项目"}</Button></div>}
      </section>
      <footer className="home-footer"><span className="footer-stitch" /><span>{ui.text("让每个好想法，成为看得见的作品。", "Make every good idea something people can see.")}</span><span className="footer-stitch" /></footer>
    </main>
  </div>;
}
export function ProjectsPage() { return isDemoMode ? <DemoProjects /> : <AuthGate><ApiProjectsContent /></AuthGate>; }
