"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronRight,
  FolderOpen,
  Layers3,
  LoaderCircle,
} from "lucide-react";
import { AppHeader } from "./app-header";
import { AuthGate } from "./auth-gate";
import { Button } from "./ui/button";
import { ProjectThumbnail } from "./demo-preview";
import { TemplateArtwork } from "./template-gallery";
import { featuredTemplates, findTemplate } from "@/lib/templates";
import { useUiPreferences } from "@/lib/ui-preferences";
import { demoApi } from "@/lib/mock-api";
import { useDemoQuery } from "@/lib/use-demo-query";
import { errorMessage, relativeTime } from "@/lib/utils";

function ProjectsContent() {
  const router = useRouter();
  const ui = useUiPreferences();
  const [prompt, setPrompt] = useState("");
  useEffect(() => {
    const slug = new URLSearchParams(window.location.search).get("template");
    const template = slug ? findTemplate(slug) : undefined;
    if (!template) return;
    queueMicrotask(() => { setPrompt(ui.locale === "en" ? template.promptEn : template.prompt); window.history.replaceState(window.history.state, "", "/projects"); });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const loader = useCallback(() => demoApi.listProjects(), []);
  const { data: projects, error: loadError, refresh } = useDemoQuery(loader);
  async function create() {
    if (!prompt.trim() || busy) return;
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
    <div className="projects-page">
      <AppHeader />
      <main className="home-main">
        <section className="home-hero" aria-labelledby="home-title">
          <div className="hero-eyebrow">
            <span className="tiny-weave">✳</span> 一个想法，无限可能
          </div>
          <h1 id="home-title">
            把想法，<span>织成应用。</span>
          </h1>
          <p className="hero-subtitle">
            从一句描述开始，让你的下一个想法有迹可循。
          </p>
          <form
            className="home-composer"
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <label className="sr-only" htmlFor="new-project-prompt">
              描述你的应用想法
            </label>
            <textarea
              id="new-project-prompt"
              ref={input}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="你想做一个什么样的应用？"
              maxLength={4000}
              disabled={busy}
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing
                ) {
                  e.preventDefault();
                  void create();
                }
              }}
            />
            <div className="home-composer-footer">
              <span>
                <Layers3 size={14} />
                <span>你描述想法，Pivloom 负责实现</span>
              </span>
              <Button type="submit" disabled={!prompt.trim() || busy}>
                {busy ? <LoaderCircle className="spin" size={16} /> : null}
                {busy ? "正在创建" : "开始创建"}
                <ArrowRight size={16} />
              </Button>
            </div>
          </form>
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          <div className="featured-templates-heading"><div><span className="section-eyebrow">START WITH A TEMPLATE</span><h2>{ui.text("先看示例，再开始创作", "Explore first. Then create.")}</h2></div><Link href="/templates">{ui.text("浏览全部模板", "Browse all templates")}<ArrowRight size={15} /></Link></div>
          <div className="featured-template-grid">{featuredTemplates.map((template) => <Link className="featured-template" href={`/templates/${template.slug}`} key={template.slug}><TemplateArtwork template={template} /><span>{ui.text(template.title, template.titleEn)}<ArrowUpRight size={14} /></span></Link>)}</div>
        </section>
        <section className="projects-section" aria-labelledby="projects-title">
          <div className="section-heading">
            <div>
              <div className="section-eyebrow">YOUR WORKSPACE</div>
              <h2 id="projects-title">
                我的项目{" "}
                <span className="project-count">{projects?.length ?? "—"}</span>
              </h2>
              <p>每一个想法，都值得接着往下做。</p>
            </div>
          </div>
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
              <h3>你的第一个想法，从这里开始</h3>
              <p>在上方描述你想创建的应用。</p>
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
        </section>
        <footer className="home-footer">
          <span className="footer-stitch" />
          <span>让每个好想法，成为看得见的作品。</span>
          <span className="footer-stitch" />
        </footer>
      </main>
    </div>
  );
}
export function ProjectsPage() {
  return (
    <AuthGate>
      <ProjectsContent />
    </AuthGate>
  );
}
