"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  Check,
  ChevronRight,
  FolderOpen,
  LoaderCircle,
  Plus,
} from "lucide-react";
import { AppHeader } from "./app-header";
import { AuthGate } from "./auth-gate";
import { LoomMark } from "./brand";
import { Button } from "./ui/button";
import { ProjectThumbnail } from "./demo-preview";
import { featuredTemplates, findTemplate } from "@/lib/templates";
import { useUiPreferences } from "@/lib/ui-preferences";
import { demoApi } from "@/lib/mock-api";
import { useDemoQuery } from "@/lib/use-demo-query";
import { errorMessage, relativeTime } from "@/lib/utils";

function ProjectsContent({ initialSurface }: { initialSurface: "new" | "projects" }) {
  const router = useRouter();
  const ui = useUiPreferences();
  const [prompt, setPrompt] = useState("");
  const [surface, setSurface] = useState<"new" | "projects">(initialSurface);
  function showSurface(next: "new" | "projects") {
    setSurface(next);
    router.push(next === "projects" ? "/projects?view=list" : "/projects", { scroll: false });
  }
  useEffect(() => {
    const onPopState = () => setSurface(new URLSearchParams(window.location.search).get("view") === "list" ? "projects" : "new");
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  useEffect(() => {
    const slug = new URLSearchParams(window.location.search).get("template");
    const template = slug ? findTemplate(slug) : undefined;
    if (!template) return;
    queueMicrotask(() => { setPrompt(ui.locale === "en" ? template.promptEn : template.prompt); setSurface("new"); window.history.replaceState(window.history.state, "", "/projects"); });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const loader = useCallback(() => demoApi.listProjects(), []);
  const { data: projects, error: loadError, refresh } = useDemoQuery(loader);
  async function create() {
    if (!prompt.trim() || busy) return;
    if (!/报名|活动|event|signup|书|阅读|reading|book|作品|个人|portfolio/i.test(prompt)) {
      setError("演示模式只提供活动报名、读书清单和个人作品集三种固定场景；任意需求请使用正式模式。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const project = await demoApi.createProject(prompt.trim());
      await demoApi.startRun(project.id, prompt.trim());
      router.push(`/projects/${project.id}`);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }
  return (
    <div className="projects-page a-projects-page">
      <AppHeader>
        <button className="a-header-view" onClick={() => showSurface(surface === "new" ? "projects" : "new")}>
          {surface === "new" ? ui.text("我的项目", "My projects") : ui.text("开始创作", "Start creating")}
          <ArrowRight size={14} />
        </button>
      </AppHeader>
      {surface === "new" ? (
        <main className="a-start" aria-labelledby="home-title">
          <div className="a-start-orbit orbit-one" aria-hidden="true" />
          <div className="a-start-orbit orbit-two" aria-hidden="true" />
          <div className="a-start-inner">
            <div className="a-start-mark"><LoomMark /><span>{ui.text("从想法到作品", "From idea to app")}</span></div>
            <h1 id="home-title">{ui.text("你想创造什么", "What will you create")}<span>？</span></h1>
            <p>{ui.text("一句话开始。工具、网站或小游戏，都可以慢慢长成你想要的样子。", "Start with a sentence. Let a tool, website or game grow from there.")}</p>
            <form className="a-start-composer" onSubmit={(event) => { event.preventDefault(); void create(); }}>
              <label className="sr-only" htmlFor="new-project-prompt">{ui.text("新项目需求", "New project request")}</label>
              <textarea id="new-project-prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)}
                placeholder={ui.text("描述你想做的作品，越具体越好…", "Describe what you want to make…")}
                maxLength={4000} disabled={busy}
                onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void create(); } }} />
              <div className="a-start-composer-bottom">
                <span className="a-start-model"><LoomMark />{ui.text("演示模式 · 模拟生成", "Demo mode · simulated generation")}</span>
                <span>{ui.text("Enter 开始 · Shift + Enter 换行", "Enter to start · Shift + Enter for a new line")}</span>
                <Button type="submit" size="icon" disabled={!prompt.trim() || busy} aria-label={ui.text("创建并开始模拟生成", "Create and start simulated generation")}>
                  {busy ? <LoaderCircle className="spin" size={18} /> : <ArrowUp size={19} />}
                </Button>
              </div>
            </form>
            {error && <p className="inline-error" role="alert">{error}</p>}
            <div className="a-start-suggestions">
              <div><span>{ui.text("试试一个想法", "Try an idea")}</span><Link href="/templates">{ui.text("浏览全部模板", "Browse templates")}<ArrowRight size={13} /></Link></div>
              <div>{featuredTemplates.map((template) => <button key={template.slug} onClick={() => setPrompt(ui.locale === "en" ? template.promptEn : template.prompt)}>{ui.text(template.title, template.titleEn)}<ArrowRight size={13} /></button>)}</div>
            </div>
            <button className="a-start-project-link" onClick={() => showSurface("projects")}>{ui.text("查看已有项目", "View existing projects")}<ArrowRight size={14} /></button>
          </div>
        </main>
      ) : (
        <main className="a-project-list">
          <div className="a-project-list-heading">
            <div><span className="section-eyebrow">YOUR WORKSPACE</span><h1 id="projects-title">{ui.text("我的项目", "My projects")}</h1><p>{ui.text("把想法变成作品，再慢慢完善。", "Make an idea real, then keep improving it.")}</p></div>
            <Button onClick={() => { setPrompt(""); setError(""); showSurface("new"); }}><Plus size={17} />{ui.text("新建项目", "New project")}</Button>
          </div>
          <div className="a-project-list-filter"><strong>{ui.text("全部项目", "All projects")} <span>{projects?.length ?? "—"}</span></strong><span>{ui.text("最近编辑", "Recently edited")}</span></div>
          {loadError ? (
            <div className="empty-projects" role="alert">
              <p>{loadError}</p>
              <Button variant="outline" onClick={refresh}>
                重新加载
              </Button>
            </div>
          ) : !projects ? (
            <div className="project-grid" aria-label="正在加载项目">
              {[0, 1, 2].map((i) => (
                <div className="project-skeleton" key={i} />
              ))}
            </div>
          ) : projects.length === 0 ? (
            <div className="empty-projects">
              <FolderOpen size={32} />
              <h2>{ui.text("还没有项目", "No projects yet")}</h2>
              <p>{ui.text("从一个想法开始，作品会保存在这里。", "Start with an idea. Your work will appear here.")}</p>
              <Button onClick={() => showSurface("new")}>{ui.text("开始创作", "Start creating")}</Button>
            </div>
          ) : (
            <div className="project-grid">
              {projects.map((project) => (
                <Link
                  className={`project-card project-card-${project.kind}`}
                  key={project.id}
                  href={`/projects/${project.id}`}
                >
                  <div className="project-thumbnail">
                    <ProjectThumbnail kind={project.kind} />
                    <span className="project-open">
                      <ArrowUpRight size={18} />
                    </span>
                  </div>
                  <div className="project-card-body">
                    <div className="project-name-row">
                      <h3>{project.title}</h3>
                      <ChevronRight size={15} />
                    </div>
                    <p>{project.description}</p>
                    <div className="project-card-meta">
                      <span
                        className={
                          project.status === "failed"
                            ? "card-state warning"
                            : "card-state"
                        }
                      >
                        {project.status === "running" ? (
                          <LoaderCircle className="spin" size={12} />
                        ) : project.status === "ready" ? (
                          <Check size={12} />
                        ) : (
                          <span className="mini-dot" />
                        )}
                        {
                          {
                            ready: "已保存",
                            running: "生成中",
                            failed: "需要重试",
                            stopped: "已停止",
                            expired: "预览已休眠",
                          }[project.status]
                        }
                      </span>
                      <time dateTime={project.updatedAt}>
                        {relativeTime(project.updatedAt)}
                      </time>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}
          <div className="a-project-list-bottom">{ui.text("从空白开始，或使用一个模板。", "Start blank or use a template.")}<Link href="/templates">{ui.text("探索模板", "Explore templates")}<ArrowRight size={14} /></Link></div>
        </main>
      )}
    </div>
  );
}
export function ProjectsPage({ initialSurface = "new" }: { initialSurface?: "new" | "projects" }) {
  return (
    <AuthGate>
      <ProjectsContent initialSurface={initialSurface} />
    </AuthGate>
  );
}
