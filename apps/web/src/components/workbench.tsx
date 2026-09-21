"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Popover } from "radix-ui";
import {
  ArrowRight,
  ArrowUp,
  BookOpen,
  Check,
  CheckCheck,
  ChevronRight,
  Code2,
  Copy,
  ExternalLink,
  FileCode2,
  FileJson2,
  FlaskConical,
  Globe2,
  LoaderCircle,
  MessageSquare,
  Monitor,
  MousePointer2,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Smartphone,
  Square,
  TriangleAlert,
} from "lucide-react";
import { AppHeader } from "./app-header";
import { AuthGate } from "./auth-gate";
import { LoomMark } from "./brand";
import { Button } from "./ui/button";
import { demoApi } from "@/lib/mock-api";
import { useDemoQuery } from "@/lib/use-demo-query";
import { cn, errorMessage } from "@/lib/utils";
import type {
  Activity,
  ChatMessage,
  Project,
  RunPhase,
  SourceFile,
} from "@/lib/types";

const phaseLabel: Record<RunPhase, string> = {
  planning: "协调者正在梳理需求",
  building: "工程师正在编写应用",
  checking: "检查者正在检查关键流程",
  stopping: "正在停止本次生成…",
  completed: "已完成",
  failed: "本次生成遇到问题",
  stopped: "本次生成已停止",
};
const roleNames = {
  coordinator: "协调者",
  builder: "工程师",
  reviewer: "检查者",
};
const roleIcons = {
  coordinator: BookOpen,
  builder: Code2,
  reviewer: MousePointer2,
};
const runningPhases: RunPhase[] = [
  "planning",
  "building",
  "checking",
  "stopping",
];

function ActivityList({ activities }: { activities: Activity[] }) {
  return (
    <ol className="activity-list">
      {activities.map((activity) => {
        const Icon = roleIcons[activity.role];
        return (
          <li key={activity.role} className={`activity-${activity.status}`}>
            <span className="activity-icon">
              {activity.status === "completed" ? (
                <Check size={12} />
              ) : activity.status === "running" ? (
                <LoaderCircle size={14} className="spin" />
              ) : activity.status === "failed" ? (
                <TriangleAlert size={13} />
              ) : (
                <Icon size={13} />
              )}
            </span>
            <div>
              <strong>{roleNames[activity.role]}</strong>
              <p>{activity.detail}</p>
            </div>
            {activity.status === "completed" && (
              <span className="activity-done">完成</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function Message({
  message,
  project,
  onPreview,
}: {
  message: ChatMessage;
  project: Project;
  onPreview: () => void;
}) {
  if (message.role === "user")
    return (
      <div className="user-message">
        <div>{message.content}</div>
      </div>
    );
  const checked =
    message.activities?.find((item) => item.role === "reviewer")?.status ===
    "completed";
  return (
    <article className="assistant-message">
      <div className="assistant-message-heading">
        <LoomMark />
        <strong>Pivloom</strong>
        <span>
          {new Date(message.createdAt).toLocaleTimeString("zh-CN", {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </span>
      </div>
      <div className="assistant-message-body">
        <p className="message-content">{message.content}</p>
        {message.activities && (
          <ActivityList activities={message.activities} />
        )}{" "}
        {checked && (
          <details className="check-details">
            <summary>
              <ChevronRight size={13} />
              查看检查详情<span className="detail-count">3</span>
            </summary>
            <div className="check-details-body">
              <span className="detail-demo">
                模拟检查记录 · v{message.revision ?? project.revision}
              </span>
              <p>
                <Check size={13} />
                页面可以正常打开
              </p>
              <p>
                <Check size={13} />
                主要交互能够完成
              </p>
              <p>
                <Check size={13} />
                窄屏布局显示正常
              </p>
              <small>用于前端状态演示，未执行真实浏览器验收。</small>
            </div>
          </details>
        )}
        {message.revision === project.revision && project.revision > 0 && (
          <button className="result-card" onClick={onPreview}>
            <span className="result-card-icon">
              <Globe2 size={19} />
            </span>
            <span>
              <strong>{project.title}</strong>
              <small>
                查看应用预览 <span>v{message.revision}</span>
              </small>
            </span>
            <ArrowUpRightIcon />
          </button>
        )}
      </div>
    </article>
  );
}

function ArrowUpRightIcon() {
  return <ExternalLink size={15} className="result-card-arrow" />;
}

function SourceViewer({
  files,
  onNotice,
}: {
  files: SourceFile[];
  onNotice: (text: string) => void;
}) {
  const [selected, setSelected] = useState("");
  const file = files.find((file) => file.path === selected) ?? files[0];
  if (!file)
    return (
      <div className="preview-empty">
        <Code2 size={28} />
        <h3>代码将出现在这里</h3>
        <p>完成第一次生成后，可以查看模拟的项目源码。</p>
      </div>
    );
  return (
    <div className="source-viewer">
      <aside className="source-tree" aria-label="项目文件">
        <div className="source-tree-title">
          文件 <span>{files.length}</span>
        </div>
        {files.map((item) => (
          <button
            key={item.path}
            className={cn("source-file", item.path === file.path && "selected")}
            onClick={() => setSelected(item.path)}
          >
            {item.path.endsWith("json") ? (
              <FileJson2 size={14} />
            ) : (
              <FileCode2 size={14} />
            )}
            <span>{item.path}</span>
          </button>
        ))}
      </aside>
      <section className="source-editor">
        <div className="source-file-bar">
          <span>
            <FileCode2 size={14} />
            {file.path}
          </span>
          <div>
            <span className="readonly-badge">模拟源码 · 只读</span>
            <Button
              variant="ghost"
              size="icon"
              aria-label="复制当前文件"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(file.content);
                  onNotice("代码已复制");
                } catch {
                  onNotice("无法读取剪贴板权限，请手动选择代码复制。");
                }
              }}
            >
              <Copy size={14} />
            </Button>
          </div>
        </div>
        <pre className="code-content" tabIndex={0} aria-label={file.path}>
          {file.content.split("\n").map((line, index) => (
            <div className="code-line" key={index}>
              <span aria-hidden="true" className="line-number">
                {index + 1}
              </span>
              <code
                className={
                  line.trim().startsWith("//")
                    ? "code-comment"
                    : line.trim().startsWith("import") ||
                        line.trim().startsWith("export")
                      ? "code-keyword"
                      : ""
                }
              >
                {line || " "}
              </code>
            </div>
          ))}
        </pre>
      </section>
    </div>
  );
}

function MockControls({
  scenario,
  onScenario,
  project,
  busy,
  onAction,
}: {
  scenario: "success" | "failure";
  onScenario: (s: "success" | "failure") => void;
  project: Project;
  busy: boolean;
  onAction: (action: () => Promise<unknown>) => void;
}) {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          className="mock-controls-trigger"
          aria-label="演示场景"
          title="演示场景"
        >
          <FlaskConical size={15} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="mock-popover" sideOffset={10} align="end">
          <h3>试试不同的生成状态</h3>
          <p>仅影响当前浏览器的模拟数据。</p>
          <label className="mock-scenario">
            <input
              type="checkbox"
              checked={scenario === "failure"}
              disabled={busy}
              onChange={(e) =>
                onScenario(e.target.checked ? "failure" : "success")
              }
            />
            <span>
              让下一次生成失败<small>体验错误提示、保留旧预览和重试</small>
            </span>
          </label>
          <Button
            variant="outline"
            size="sm"
            disabled={
              busy || project.revision === 0 || project.status === "expired"
            }
            onClick={() => onAction(() => demoApi.expirePreview(project.id))}
          >
            <RotateCcw size={13} />
            模拟预览过期
          </Button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function WorkbenchContent({ projectId }: { projectId: string }) {
  const loader = useCallback(() => demoApi.getProject(projectId), [projectId]);
  const { data: project, error: loadError, refresh } = useDemoQuery(loader);
  const [draft, setDraft] = useState("");
  const [tab, setTab] = useState<"preview" | "code">("preview");
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const [mobileTab, setMobileTab] = useState<"chat" | "result">("chat");
  const [collapsed, setCollapsed] = useState(false);
  const [scenario, setScenario] = useState<"success" | "failure">("success");
  const [pending, setPending] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const bottom = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const run = project?.activeRun;
  const running = !!run && runningPhases.includes(run.phase);
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [project?.messages.length, run?.phase]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 3500);
    return () => clearTimeout(timer);
  }, [notice]);

  async function perform(action: () => Promise<unknown>) {
    setError("");
    try {
      await action();
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  async function send(value = draft) {
    if (!value.trim() || pending || running) return;
    setPending(true);
    setError("");
    try {
      await demoApi.startRun(projectId, value.trim(), scenario);
      setDraft("");
      setScenario("success");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(false);
    }
  }
  async function restore() {
    setRestoring(true);
    await perform(() => demoApi.restorePreview(projectId));
    setRestoring(false);
    setReloadKey((v) => v + 1);
  }
  function showPreview() {
    setTab("preview");
    setMobileTab("result");
  }
  if (loadError)
    return (
      <>
        <AppHeader />
        <main className="standalone-state">
          <TriangleAlert size={32} />
          <h1>暂时无法打开这个项目</h1>
          <p role="alert">{loadError}</p>
          <div className="inline-actions">
            <Button variant="outline" onClick={refresh}>
              重新加载
            </Button>
            <Button asChild>
              <Link href="/projects">返回我的项目</Link>
            </Button>
          </div>
        </main>
      </>
    );
  if (!project)
    return (
      <>
        <AppHeader />
        <div className="page-loader">
          <LoaderCircle className="spin" size={24} />
          <span>正在打开项目…</span>
        </div>
      </>
    );
  const previewUrl = `/preview/${project.kind}?revision=${project.revision}&features=${encodeURIComponent(project.features.join(","))}`;
  const hasPreview = project.revision > 0;
  const lastPrompt =
    [...project.messages].reverse().find((message) => message.role === "user")
      ?.content ?? project.description;
  return (
    <div className="workbench-page">
      <AppHeader title={project.title} saving={running}>
        <MockControls
          scenario={scenario}
          onScenario={setScenario}
          project={project}
          busy={running || pending}
          onAction={(action) => void perform(action)}
        />
      </AppHeader>
      <nav className="mobile-workbench-tabs" aria-label="工作区">
        <button
          aria-pressed={mobileTab === "chat"}
          onClick={() => setMobileTab("chat")}
        >
          <MessageSquare size={15} />
          对话{running && <span className="mini-dot" />}
        </button>
        <button
          aria-pressed={mobileTab === "result"}
          onClick={() => setMobileTab("result")}
        >
          <Monitor size={15} />
          结果{hasPreview && <span>v{project.revision}</span>}
        </button>
      </nav>
      <main
        className={cn(
          "workbench-layout",
          collapsed && "chat-collapsed",
          `mobile-show-${mobileTab}`,
        )}
      >
        <section className="chat-panel" aria-label="与 Pivloom 对话">
          <div className="chat-panel-heading">
            <div>
              <span className="chat-heading-icon">
                <MessageSquare size={15} />
              </span>
              <strong>构建你的想法</strong>
              <span className="conversation-badge">对话</span>
            </div>
            <button
              className="icon-button collapse-button"
              onClick={() => setCollapsed(true)}
              aria-label="收起对话"
            >
              <PanelLeftClose size={16} />
            </button>
          </div>
          <div className="chat-scroll">
            {project.messages.length === 0 ? (
              <div className="chat-welcome">
                <LoomMark />
                <h2>想法已经就位</h2>
                <p>告诉我你想实现什么，我们一起把它变成可试用的应用。</p>
              </div>
            ) : (
              <>
                <div className="conversation-date">今天</div>
                {project.messages.map((message) => (
                  <Message
                    key={message.id}
                    message={message}
                    project={project}
                    onPreview={showPreview}
                  />
                ))}
              </>
            )}
            {running && (
              <article className="assistant-message active-message">
                <div className="assistant-message-heading">
                  <LoomMark />
                  <strong>Pivloom</strong>
                  <span className="live-label">处理中</span>
                </div>
                <div className="assistant-message-body">
                  <p className="run-label" role="status">
                    {phaseLabel[run!.phase]}
                  </p>
                  <ActivityList activities={run!.activities} />
                  <span className="simulation-caption">模拟执行过程</span>
                </div>
              </article>
            )}
            <div ref={bottom} />
          </div>
          <div className="chat-bottom">
            {(project.status === "failed" || project.status === "stopped") &&
              !running && (
                <div
                  className={cn(
                    "run-notice",
                    project.status === "failed" && "run-notice-error",
                  )}
                  role="status"
                >
                  {project.status === "failed" ? (
                    <TriangleAlert size={16} />
                  ) : (
                    <Square size={14} />
                  )}
                  <div>
                    <strong>
                      {project.status === "failed"
                        ? "这次生成未完成"
                        : "已停止本次生成"}
                    </strong>
                    <p>
                      {project.status === "failed"
                        ? (run?.error ??
                          "模拟的构建失败，已保留上一个可用版本。")
                        : "已保存的项目和预览仍然保留。"}
                    </p>
                  </div>
                  <button
                    onClick={() => void send(lastPrompt)}
                    disabled={pending}
                  >
                    <RotateCcw size={13} />
                    重试
                  </button>
                </div>
              )}
            {error && (
              <p className="inline-error" role="alert">
                {error}
              </p>
            )}
            {!running && hasPreview && (
              <div className="followup-prompts">
                <button
                  onClick={() => {
                    setDraft(
                      project.kind === "events"
                        ? "增加按报名状态筛选的功能"
                        : "让页面在手机上也好用",
                    );
                    composer.current?.focus();
                  }}
                >
                  <PlusSmall />{" "}
                  {project.kind === "events" ? "增加状态筛选" : "适配手机布局"}
                </button>
                <button
                  onClick={() => {
                    setDraft("优化页面细节，让界面更简洁");
                    composer.current?.focus();
                  }}
                >
                  优化页面细节
                  <ArrowRight size={11} />
                </button>
              </div>
            )}
            <form
              className={cn("chat-composer", running && "composer-running")}
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              <label htmlFor="followup-prompt" className="sr-only">
                继续修改应用
              </label>
              <textarea
                ref={composer}
                id="followup-prompt"
                placeholder="继续描述你想修改的地方…"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                maxLength={4000}
                onKeyDown={(e) => {
                  if (
                    e.key === "Enter" &&
                    !e.shiftKey &&
                    !e.nativeEvent.isComposing
                  ) {
                    e.preventDefault();
                    void send();
                  }
                }}
              />
              <div className="chat-composer-controls">
                <span>
                  <span className="small-status-dot" />
                  {running ? "Pivloom 正在工作" : "准备好你的下一个想法"}
                </span>
                {running ? (
                  <Button
                    variant="secondary"
                    size="icon"
                    disabled={run?.phase === "stopping"}
                    aria-label={
                      run?.phase === "stopping" ? "正在停止" : "停止生成"
                    }
                    title={run?.phase === "stopping" ? "正在停止" : "停止生成"}
                    onClick={() =>
                      void perform(() => demoApi.stopRun(projectId))
                    }
                  >
                    {run?.phase === "stopping" ? (
                      <LoaderCircle className="spin" size={16} />
                    ) : (
                      <Square size={13} fill="currentColor" />
                    )}
                  </Button>
                ) : (
                  <Button
                    type="submit"
                    size="icon"
                    disabled={!draft.trim() || pending}
                    aria-label="发送修改需求"
                  >
                    {pending ? (
                      <LoaderCircle className="spin" size={16} />
                    ) : (
                      <ArrowUp size={18} />
                    )}
                  </Button>
                )}
              </div>
            </form>
            <div className="composer-hint">
              <span>
                Enter 发送 <span>·</span> Shift + Enter 换行
              </span>
              <span>
                {scenario === "failure" ? "下次模拟失败" : "Mock 数据"}
              </span>
            </div>
          </div>
        </section>
        <section className="result-panel" aria-label="应用结果">
          <div className="result-toolbar">
            <div className="result-toolbar-left">
              {collapsed && (
                <button
                  className="icon-button expand-chat-button"
                  onClick={() => setCollapsed(false)}
                  aria-label="展开对话"
                >
                  <PanelLeftOpen size={16} />
                </button>
              )}
              <div className="view-tabs" role="tablist" aria-label="结果视图">
                <button
                  id="preview-tab"
                  role="tab"
                  aria-selected={tab === "preview"}
                  aria-controls="preview-panel"
                  tabIndex={tab === "preview" ? 0 : -1}
                  onClick={() => setTab("preview")}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowRight") {
                      setTab("code");
                      document.getElementById("code-tab")?.focus();
                    }
                  }}
                >
                  <Monitor size={14} />
                  预览
                </button>
                <button
                  id="code-tab"
                  role="tab"
                  aria-selected={tab === "code"}
                  aria-controls="code-panel"
                  tabIndex={tab === "code" ? 0 : -1}
                  onClick={() => setTab("code")}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowLeft") {
                      setTab("preview");
                      document.getElementById("preview-tab")?.focus();
                    }
                  }}
                >
                  <Code2 size={15} />
                  代码
                </button>
              </div>
            </div>
            <div className="preview-status">
              {hasPreview && (
                <span className="version-badge">v{project.revision}</span>
              )}
              {hasPreview && !running && project.status !== "expired" && (
                <span className="preview-checked">
                  <ShieldCheck size={13} />
                  模拟检查通过
                </span>
              )}
              {running && (
                <span className="preview-building">
                  <LoaderCircle size={12} className="spin" />
                  生成中
                </span>
              )}
            </div>
            <div className="preview-actions">
              {tab === "preview" && (
                <>
                  <div className="device-toggle" aria-label="预览宽度">
                    <button
                      aria-label="桌面预览"
                      aria-pressed={device === "desktop"}
                      onClick={() => setDevice("desktop")}
                      title="桌面预览"
                    >
                      <Monitor size={15} />
                    </button>
                    <button
                      aria-label="手机预览"
                      aria-pressed={device === "mobile"}
                      onClick={() => setDevice("mobile")}
                      title="390px 手机预览"
                    >
                      <Smartphone size={15} />
                    </button>
                  </div>
                  <span className="toolbar-divider" />
                  <button
                    className="icon-button"
                    aria-label="刷新预览"
                    title="刷新预览"
                    disabled={!hasPreview || project.status === "expired"}
                    onClick={() => {
                      setReloadKey((v) => v + 1);
                      setNotice("预览已刷新");
                    }}
                  >
                    <RefreshCw size={15} />
                  </button>
                  <a
                    className={cn(
                      "icon-button",
                      (!hasPreview || project.status === "expired") &&
                        "disabled-link",
                    )}
                    href={
                      hasPreview && project.status !== "expired"
                        ? previewUrl
                        : undefined
                    }
                    aria-disabled={!hasPreview || project.status === "expired"}
                    tabIndex={
                      !hasPreview || project.status === "expired" ? -1 : 0
                    }
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label="在新标签页打开预览"
                    title="在新标签页打开预览"
                  >
                    <ExternalLink size={15} />
                  </a>
                </>
              )}
            </div>
          </div>
          {running && hasPreview && (
            <div className="previous-version-note">
              <span className="mini-dot" />
              正在显示已保存的 v{project.revision}，新版本准备好后会自动更新。
            </div>
          )}
          <div
            id="code-panel"
            role="tabpanel"
            aria-labelledby="code-tab"
            className="code-panel"
            hidden={tab !== "code"}
          >
            <SourceViewer files={project.files} onNotice={setNotice} />
          </div>
          <div
            id="preview-panel"
            role="tabpanel"
            aria-labelledby="preview-tab"
            className={cn(
              "preview-canvas",
              device === "mobile" && "preview-canvas-mobile",
            )}
            hidden={tab !== "preview"}
          >
            {project.status === "expired" ? (
              <div className="preview-empty">
                <div className="empty-preview-icon">
                  <RotateCcw size={27} />
                </div>
                <h2>让你的应用重新醒来</h2>
                <p>源码已保存，预览需要重新启动。</p>
                <Button disabled={restoring} onClick={() => void restore()}>
                  {restoring ? (
                    <LoaderCircle className="spin" size={15} />
                  ) : (
                    <Play size={14} />
                  )}{" "}
                  {restoring ? "正在恢复预览…" : "恢复预览"}
                </Button>
                <small>恢复已有版本，不会重新生成代码</small>
              </div>
            ) : hasPreview ? (
              <div
                className={cn(
                  "preview-frame",
                  device === "mobile" && "phone-frame",
                )}
              >
                <iframe
                  key={`${project.revision}-${reloadKey}`}
                  src={previewUrl}
                  title={`${project.title}交互预览`}
                  className="app-preview-iframe"
                />
              </div>
            ) : (
              <div className="preview-empty">
                <div
                  className={cn(
                    "empty-preview-icon",
                    running && "working-mark",
                  )}
                >
                  <LoomMark />
                </div>
                <span className="eyebrow">YOUR NEXT IDEA</span>
                <h2>
                  {running ? "你的想法，正在成为现实" : "应用即将从这里开始"}
                </h2>
                <p>
                  {running
                    ? "规划、构建、检查，一步步把细节织在一起。"
                    : "在左侧描述需求，即可开始第一次模拟生成。"}
                </p>
                {running && (
                  <span className="empty-stage">
                    <LoaderCircle className="spin" size={14} />
                    {phaseLabel[run!.phase]}
                  </span>
                )}
              </div>
            )}
          </div>
          <div className="result-footer">
            <span>
              <Globe2 size={12} />
              {tab === "code" ? "项目源码" : "可交互预览"}
            </span>
            <span>
              {device === "mobile" && tab === "preview"
                ? "390px · 手机视图"
                : "所有生成与检查使用模拟数据"}
            </span>
          </div>
        </section>
      </main>
      {notice && (
        <div className="toast" role="status">
          <CheckCheck size={16} />
          {notice}
        </div>
      )}
    </div>
  );
}

function PlusSmall() {
  return <span aria-hidden="true">＋</span>;
}
export function Workbench({ projectId }: { projectId: string }) {
  return (
    <AuthGate>
      <WorkbenchContent projectId={projectId} />
    </AuthGate>
  );
}
