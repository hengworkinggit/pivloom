"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  CalendarDays,
  Check,
  ChevronRight,
  FolderOpen,
  Layers3,
  LoaderCircle,
  Plus,
  UserRound,
} from "lucide-react";
import { AppHeader } from "./app-header";
import { AuthGate } from "./auth-gate";
import { Button } from "./ui/button";
import { ProjectThumbnail } from "./demo-preview";
import { demoApi } from "@/lib/mock-api";
import { useDemoQuery } from "@/lib/use-demo-query";
import { errorMessage, relativeTime } from "@/lib/utils";
import type { ProjectKind } from "@/lib/types";

const starters = [
  {
    kind: "events" as ProjectKind,
    title: "活动报名",
    icon: CalendarDays,
    prompt: "做一个活动报名管理页面，支持新增报名、搜索、状态筛选和人数统计。",
  },
  {
    kind: "books" as ProjectKind,
    title: "读书清单",
    icon: BookOpen,
    prompt: "做一个温暖简洁的读书清单，可以添加书籍、搜索和管理阅读状态。",
  },
  {
    kind: "portfolio" as ProjectKind,
    title: "个人作品集",
    icon: UserRound,
    prompt: "做一个极简的设计师个人作品集，展示项目、个人介绍和联系方式。",
  },
];

function ProjectsContent() {
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
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
          <div className="starter-list">
            <span>从这里开始</span>
            {starters.map(({ kind, title, icon: Icon, prompt: text }) => (
              <button
                key={kind}
                className="starter-chip"
                disabled={busy}
                onClick={() => {
                  setPrompt(text);
                  input.current?.focus();
                }}
              >
                <Icon size={14} />
                {title}
                <ArrowUpRight size={12} />
              </button>
            ))}
          </div>
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
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setPrompt("");
                input.current?.focus();
                window.scrollTo({ top: 0, behavior: "smooth" });
              }}
            >
              <Plus size={15} />
              新建项目
            </Button>
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
