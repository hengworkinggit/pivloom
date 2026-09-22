"use client";

import { useCallback, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowRight, ArrowUpRight, BookOpen, CalendarDays, ChevronRight, FolderOpen, Layers3, LoaderCircle, Plus, UserRound } from "lucide-react";
import type { ProjectSummary } from "@pivloom/contracts";
import { AppHeader } from "./app-header";
import { AuthGate } from "./auth-gate";
import { Button } from "./ui/button";
import { LoomMark } from "./brand";
import { getApiWorkspace, isDemoMode } from "@/lib/workspace";
import { usePrivateQuery, useWorkspaceAuth } from "@/lib/use-workspace";
import { errorMessage, relativeTime } from "@/lib/utils";
import { promptLimit, readDraft, saveDraft } from "@/lib/drafts";

const DemoProjects = dynamic(() => import("./demo-projects-page").then((module) => module.ProjectsPage));
const starters = [
  { title: "活动报名", icon: CalendarDays, prompt: "做一个活动报名管理页面，支持新增报名、搜索、状态筛选和人数统计。" },
  { title: "读书清单", icon: BookOpen, prompt: "做一个温暖简洁的读书清单，可以添加书籍、搜索和管理阅读状态。" },
  { title: "个人作品集", icon: UserRound, prompt: "做一个极简的设计师个人作品集，展示项目、个人介绍和联系方式。" },
];

function ProjectCard({ project }: { project: ProjectSummary }) {
  return <Link className="project-card project-card-api" href={`/projects/${project.id}`}>
    <div className="project-thumbnail api-project-thumbnail"><LoomMark /><span>{project.currentRevisionId ? "打开项目" : "等待你的第一个版本"}</span><span className="project-open"><ArrowUpRight size={18} /></span></div>
    <div className="project-card-body">
      <div className="project-name-row"><h3>{project.title}</h3><ChevronRight size={15} /></div>
      <p>{project.currentRevisionId ? "继续完善你的应用" : "项目已保存，随时开始创作"}</p>
      <div className="project-card-meta"><span className="card-state"><span className="mini-dot" />{project.currentRevisionId ? "已有版本" : "空项目"}</span><time dateTime={project.updatedAt}>{relativeTime(project.updatedAt)}</time></div>
    </div>
  </Link>;
}

function ApiProjectsContent() {
  const router = useRouter();
  const api = getApiWorkspace();
  const { user } = useWorkspaceAuth();
  const [prompt, setPrompt] = useState(() => readDraft(user!.id, "new"));
  const [busy, setBusy] = useState(false);
  const creating = useRef(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const [pages, setPages] = useState<ProjectSummary[]>([]);
  const [next, setNext] = useState<string | null | undefined>();
  const [loadingMore, setLoadingMore] = useState(false);
  const loader = useCallback(() => api.listProjects(), [api]);
  const { data, error: loadError, refresh } = usePrivateQuery(loader);
  const projects = data ? [...data.projects, ...pages.filter((project) => !data.projects.some((item) => item.id === project.id))] : undefined;
  const cursor = next === undefined ? data?.nextCursor : next;
  const tooLong = prompt.trim().length > promptLimit;
  function updatePrompt(value: string) { setPrompt(value); saveDraft(user!.id, "new", value); }
  async function create(empty = false) {
    if (creating.current || (!empty && (!prompt.trim() || tooLong))) return;
    creating.current = true; setBusy(true); setError("");
    try {
      const project = await api.createProject(empty ? undefined : prompt.trim().slice(0, 120));
      if (!empty) saveDraft(user!.id, project.id, prompt.trim());
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
        <div className="hero-eyebrow"><span className="tiny-weave">✳</span> 一个想法，无限可能</div>
        <h1 id="home-title">把想法，<span>织成应用。</span></h1>
        <p className="hero-subtitle">从一句描述开始，让你的下一个想法有迹可循。</p>
        <form className="home-composer" onSubmit={(event) => { event.preventDefault(); void create(); }}>
          <label className="sr-only" htmlFor="new-project-prompt">描述你的应用想法</label>
          <textarea id="new-project-prompt" ref={input} value={prompt} onChange={(event) => updatePrompt(event.target.value)} placeholder="你想做一个什么样的应用？" disabled={busy} aria-invalid={tooLong} aria-describedby={tooLong ? "prompt-error" : undefined}
            onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void create(); } }} />
          <div className="home-composer-footer"><span><Layers3 size={14} /><span>先保存想法，进入你的项目</span></span><Button type="submit" disabled={!prompt.trim() || tooLong || busy}>{busy && <LoaderCircle className="spin" size={16} />}{busy ? "正在创建" : "创建项目"}<ArrowRight size={16} /></Button></div>
        </form>
        {tooLong && <p id="prompt-error" className="inline-error" role="alert">需求最多 {promptLimit.toLocaleString()} 个字符，请缩短后再创建。</p>}
        {error && <p className="inline-error" role="alert">{error}</p>}
        <div className="starter-list"><span>从这里开始</span>{starters.map(({ title, icon: Icon, prompt: value }) => <button key={title} className="starter-chip" disabled={busy} onClick={() => { updatePrompt(value); input.current?.focus(); }}><Icon size={14} />{title}<ArrowUpRight size={12} /></button>)}</div>
      </section>
      <section className="projects-section" aria-labelledby="projects-title">
        <div className="section-heading"><div><div className="section-eyebrow">YOUR WORKSPACE</div><h2 id="projects-title">我的项目 <span className="project-count">{projects?.length ?? "—"}</span></h2><p>每一个想法，都值得接着往下做。</p></div><Button variant="outline" size="sm" disabled={busy} onClick={() => void create(true)}><Plus size={15} />新建项目</Button></div>
        {loadError ? <div className="empty-projects" role="alert"><p>{loadError}</p><Button variant="outline" onClick={refresh}>重新加载</Button></div>
          : !projects ? <div className="project-grid" aria-label="正在加载项目">{[0, 1, 2].map((i) => <div className="project-skeleton" key={i} />)}</div>
          : projects.length === 0 ? <div className="empty-projects"><FolderOpen size={32} /><h3>你的第一个想法，从这里开始</h3><p>描述一个想法，或新建空项目。这里会保存属于你的作品。</p><Button variant="outline" asChild><Link href="/settings/models">先连接模型<ArrowRight size={15} /></Link></Button></div>
          : <div className="project-grid">{projects.map((project) => <ProjectCard key={project.id} project={project} />)}</div>}
        {cursor && <div className="load-more-projects"><Button variant="outline" disabled={loadingMore} onClick={() => void more()}>{loadingMore ? "正在加载" : "加载更多项目"}</Button></div>}
      </section>
      <footer className="home-footer"><span className="footer-stitch" /><span>让每个好想法，成为看得见的作品。</span><span className="footer-stitch" /></footer>
    </main>
  </div>;
}
export function ProjectsPage() { return isDemoMode ? <DemoProjects /> : <AuthGate><ApiProjectsContent /></AuthGate>; }
